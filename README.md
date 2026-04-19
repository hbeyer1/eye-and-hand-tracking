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

## Gaze Duel (`index-duel.html`)

Head-to-head 12-round comparison between **our** gaze model (rectified
40×20 eye patches + yaw/pitch/roll features, dual-form ridge regression —
ported from `index-rectified-reg.html`) and **WebGazer** (axis-aligned
60×10 patches, ridge regression). Both models run concurrently on the
same camera, train on the same clicks, and at each click snapshot their
prediction *before* receiving that click as a training sample — so the
per-round score is a held-out measurement.

Open `http://localhost:8765/index-duel.html` after starting
`python3 -m http.server 8765`. First 8 clicks seed both models
(a banner counts them down), then a match runs 12 targets drawn from a
4×3 grid with jitter. The summary card shows cumulative RMSE, round
record, a yaw × pitch error heatmap per model (shared colour scale), and
a trophy. Hotkeys: <kbd>N</kbd> new match, <kbd>R</kbd> reset (clears
both models — calls `webgazer.clearData()` under the hood).

### Why the WebGazer bundle is vendored

The duel loads WebGazer from `vendor/webgazer/www/webgazer.js` plus the
MediaPipe face-mesh assets under `vendor/webgazer/www/mediapipe/`. Those
files are cherry-picked from the `webgazer-demo` branch rather than
fetched from jsdelivr at runtime because:

1. **Offline / LAN reliability** — the demo works with no outbound
   network once loaded.
2. **Version pinning** — the bundle captured on `webgazer-demo` is
   known-compatible with the API calls we use here. CDN drift (jsdelivr
   serving a newer build) could silently change behaviour like the
   default Kalman filter or the face-mesh runtime.
3. **MediaPipe asset URLs are not trivially overridable from a CDN
   build** — WebGazer uses `params.faceMeshSolutionPath` (default
   `./mediapipe/face_mesh`). Hosting the assets ourselves lets us point
   that param at a local path without patching the bundle.

Our own model's MediaPipe Tasks Vision build still loads from jsdelivr
(`@mediapipe/tasks-vision@0.10.9`) to match the other demos in this repo.

## Project structure

```
index.html                # v1 — browser-only tracking + cursors
index-v2.html             # v2 — adds WebSocket client that talks to the bridge
index-rectified-reg.html  # rectified + pose gaze regression reference
index-duel.html           # ours vs WebGazer head-to-head
server.py                 # v2 — local Python bridge (Quartz + websockets)
requirements.txt          # Python deps for the bridge
vendor/webgazer/          # pinned WebGazer bundle + MediaPipe assets
```
