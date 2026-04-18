# Eye & Hand Tracking

Webcam-based face, gaze, and hand tracking in the browser using MediaPipe
Tasks, rendered with a Three.js avatar. Two versions:

- **v1 (`index.html`)** — everything runs in the browser. Draws cursors on
  the page for each index finger and for your estimated gaze point, with a
  9-point and click-based gaze calibration system and a pinch-to-pop game.
- **v2 (`index-v2.html`)** — same tracking UI, plus a tiny local Python
  bridge that takes normalized gaze / finger coordinates and drives the
  real macOS system cursor across all connected displays. Pinching
  thumb + index becomes a real mouse click. Touching your trackpad
  temporarily yields control so you can always grab the cursor back.

## Requirements

- A modern Chromium-based browser (Chrome / Edge / Arc) with webcam access.
- For **v2** only: macOS, Python 3.10+, and Accessibility permission for
  whichever terminal app runs the bridge.

## Running v1 (browser only)

From the project root:

```
python3 -m http.server 8765
```

Then open <http://localhost:8765/index.html>. Grant camera access. The
stats panel on the right has toggles for calibration, the pinch game, and
so on.

## Running v2 (system mouse control)

v2 needs the Python bridge running alongside the HTTP server. First-time
setup (creates a virtualenv for the bridge's dependencies):

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Then, in two terminal tabs from the project root:

**Terminal 1 — bridge**

```
.venv/bin/python -u server.py
```

It will print the virtual-desktop bounds and one line per display.

**Terminal 2 — static file server**

```
python3 -m http.server 8765
```

Open <http://localhost:8765/index-v2.html>. In the sidebar, scroll to
**System mouse** and:

1. Click **Connect to bridge** (the label should flip to `connected`).
2. Pick a **Source** — gaze, right hand, or left hand.
3. Tick **Control**.
4. The first real mouse event will trigger a macOS prompt for Accessibility
   permission, attributed to whichever terminal is running `server.py`.
   Grant it, then **restart the bridge** for the permission to take effect.

### Notes on v2

- **Multiple monitors** — the bridge reports the union rect of every
  active display on connect, and the browser window is mapped to that
  combined rect. Gazing at the top of your browser window reaches the top
  of the topmost display; gazing to the right reaches the rightmost one.
  Works best when the browser is fullscreen on one display.
- **Pinch click** — with a hand source selected and "Pinch → click"
  enabled, the rising edge of a pinch sends mouse-down and the falling
  edge sends mouse-up. That means you can also click-and-drag.
- **Trackpad yield** — before each commanded move, the bridge checks
  whether the real cursor has drifted away from where it last sent it. If
  it has, a human must have touched the trackpad, so the bridge pauses
  for 1.5 s. You never have to toggle anything to regain manual control.
- **Gaze accuracy** — out of the box, gaze is jittery. Calibrate with the
  9-point flow in the sidebar, or just leave "Learn from clicks" on and
  use the page normally — it gets noticeably better after ~20 clicks.

## Project structure

```
index.html         # v1 — browser-only tracking + cursors
index-v2.html      # v2 — adds WebSocket client that talks to the bridge
server.py          # v2 — local Python bridge (Quartz + websockets)
requirements.txt   # Python deps for the bridge
```
