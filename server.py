"""
Local mouse-control bridge for the Eye & Hand Tracking browser app (v2).

Listens on ws://127.0.0.1:8766 and drives the macOS system cursor via Quartz,
mapping normalized [0,1] coords from the browser into the full virtual
desktop (union of all active displays), so multi-monitor layouts work.

Setup:
    pip install websockets pyobjc-framework-Quartz

    Grant Accessibility permission to whichever terminal/app runs this:
        System Settings -> Privacy & Security -> Accessibility

Run:
    python3 server.py
"""

import asyncio
import json
import sys
import time

import websockets
import Quartz


HOST = "127.0.0.1"
PORT = 8766
MAX_DISPLAYS = 32

# Trackpad/manual-input yield: if the real cursor drifts from where we last
# commanded it, we assume the human touched the trackpad and stop driving
# the cursor for YIELD_SECONDS. Threshold is in pixels (squared).
YIELD_SECONDS = 1.5
YIELD_DRIFT_PX2 = 9.0  # (~3px)


def active_displays():
    err, display_ids, count = Quartz.CGGetActiveDisplayList(MAX_DISPLAYS, None, None)
    if err or not count:
        return []
    out = []
    for did in display_ids[:count]:
        b = Quartz.CGDisplayBounds(did)
        out.append({
            "id": int(did),
            "main": bool(Quartz.CGDisplayIsMain(did)),
            "x": float(b.origin.x),
            "y": float(b.origin.y),
            "w": float(b.size.width),
            "h": float(b.size.height),
        })
    return out


def virtual_bounds(displays):
    if not displays:
        main = Quartz.CGMainDisplayID()
        b = Quartz.CGDisplayBounds(main)
        return (float(b.origin.x), float(b.origin.y),
                float(b.size.width), float(b.size.height))
    min_x = min(d["x"] for d in displays)
    min_y = min(d["y"] for d in displays)
    max_x = max(d["x"] + d["w"] for d in displays)
    max_y = max(d["y"] + d["h"] for d in displays)
    return (min_x, min_y, max_x - min_x, max_y - min_y)


# Last-known pointer position; click events fire there.
_state = {
    "x": 0.0, "y": 0.0, "down": False,
    "last_cmd": None,   # (x, y) we last told macOS to go to, or None
    "yield_until": 0.0, # epoch seconds; while now < this, we yield control
    "yield_logged": False,
}


def _post(kind, x, y):
    event = Quartz.CGEventCreateMouseEvent(
        None, kind, (x, y), Quartz.kCGMouseButtonLeft
    )
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)


def current_mouse():
    """Read the real system cursor position."""
    ev = Quartz.CGEventCreate(None)
    loc = Quartz.CGEventGetLocation(ev)
    return (loc.x, loc.y)


def _check_user_took_over():
    """If the cursor drifted from where we last commanded, a human moved
    it (trackpad/mouse). Enter yielded state."""
    last = _state["last_cmd"]
    if last is None:
        return
    cx, cy = current_mouse()
    dx = cx - last[0]
    dy = cy - last[1]
    if dx * dx + dy * dy > YIELD_DRIFT_PX2:
        _state["yield_until"] = time.time() + YIELD_SECONDS
        if not _state["yield_logged"]:
            print(f"[yield] user took over at ({cx:.0f},{cy:.0f}) — pausing {YIELD_SECONDS:.1f}s")
            _state["yield_logged"] = True


def _yielding():
    if time.time() < _state["yield_until"]:
        return True
    if _state["yield_logged"]:
        print("[yield] resuming")
        _state["yield_logged"] = False
    return False


def move_to(x, y):
    _check_user_took_over()
    if _yielding():
        # Don't fight the user. Also forget our last commanded position so
        # the first move after resume doesn't trigger another yield.
        _state["last_cmd"] = None
        return
    kind = Quartz.kCGEventLeftMouseDragged if _state["down"] else Quartz.kCGEventMouseMoved
    _post(kind, x, y)
    _state["x"], _state["y"] = x, y
    _state["last_cmd"] = (x, y)


def mouse_down():
    if _state["down"]:
        return
    if _yielding():
        return
    _post(Quartz.kCGEventLeftMouseDown, _state["x"], _state["y"])
    _state["down"] = True


def mouse_up():
    if not _state["down"]:
        return
    _post(Quartz.kCGEventLeftMouseUp, _state["x"], _state["y"])
    _state["down"] = False


def click_at():
    mouse_down()
    mouse_up()


def clamp01(v):
    v = float(v)
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


async def handle(websocket):
    displays = active_displays()
    bx, by, bw, bh = virtual_bounds(displays)
    peer = getattr(websocket, "remote_address", None)
    print(f"[client] connected from {peer}")
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("type")
            if t == "hello":
                # Re-query in case the user changed display arrangement
                displays = active_displays()
                bx, by, bw, bh = virtual_bounds(displays)
                await websocket.send(json.dumps({
                    "type": "hello",
                    "bounds": {"x": bx, "y": by, "w": bw, "h": bh},
                    "displays": displays,
                }))
            elif t == "move":
                if "x" in msg and "y" in msg:
                    move_to(float(msg["x"]), float(msg["y"]))
                else:
                    nx = clamp01(msg.get("nx", 0.5))
                    ny = clamp01(msg.get("ny", 0.5))
                    move_to(bx + nx * bw, by + ny * bh)
            elif t == "down":
                mouse_down()
            elif t == "up":
                mouse_up()
            elif t == "click":
                click_at()
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        # Never leave a button stuck down on disconnect
        if _state["down"]:
            mouse_up()
        print("[client] disconnected")


async def main():
    displays = active_displays()
    bx, by, bw, bh = virtual_bounds(displays)
    print(f"virtual desktop: x={bx:.0f} y={by:.0f} w={bw:.0f} h={bh:.0f}")
    for d in displays:
        tag = " (main)" if d["main"] else ""
        print(f"  display {d['id']}: {d['w']:.0f}x{d['h']:.0f} @ ({d['x']:.0f},{d['y']:.0f}){tag}")
    print(f"listening on ws://{HOST}:{PORT}")
    print("grant Accessibility permission if the cursor doesn't move.")
    async with websockets.serve(handle, HOST, PORT):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
