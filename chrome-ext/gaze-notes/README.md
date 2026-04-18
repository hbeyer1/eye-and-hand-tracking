# Gaze Notes — Phase 1 Chrome extension

Shared webcam gaze tracking across Chrome tabs. Phase 1 only: calibration
infrastructure, debug dot, persistent storage. Screenshot + multimodal +
autocomplete are future phases.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select `chrome-ext/gaze-notes`.
4. The extension appears in the list — pin it to the toolbar.
5. Open any HTTP(S) tab; Chrome prompts for camera permission the first
   time MediaPipe's offscreen document starts getUserMedia. Allow it.
6. Click the toolbar icon → **Toggle dot** to show the gaze cursor in
   the active tab. Click around normal pages to add calibration samples.

## Architectural choices

### Offscreen document for the camera (not service worker, not shared worker)

MV3 service workers are the standard "always-available" background context,
but they cannot access `navigator.mediaDevices.getUserMedia` and are
aggressively suspended. Shared workers can't touch the camera either.

The only MV3 primitive that can hold a persistent camera handle is the
**offscreen document** — an invisible HTML page Chrome keeps alive as long
as the `USER_MEDIA` reason is declared. So `offscreen.html` owns:

- the `<video>` element and the camera stream,
- the MediaPipe FaceLandmarker instance,
- the ridge-regression model,
- the prediction loop.

It broadcasts predictions (~30 Hz) to the service worker, which fans them
out to every tab's content script.

### Single shared model across tabs (not per-tab)

Instantiating MediaPipe per tab would duplicate the camera stream (Chrome
allows it, but it's wasteful) and fragment calibration — each tab would
train its own regression. Instead there's **one model, one camera**, and
clicks from any tab feed into the same regression. The model predicts
**normalized** coordinates in the `[0, 1]` viewport space, so it's
tab-size invariant: a prediction of `(0.3, 0.5)` means "30% from the left
edge, 50% from the top," which each content script multiplies by its own
`innerWidth`/`innerHeight`.

### Persistence

`chrome.storage.local` holds the raw calibration samples (features +
normalized targets) and `λ`. Weights themselves aren't stored — on
startup the offscreen document pulls samples from storage and re-fits
(fast: dual-form ridge is O(n³) in sample count, which is small).

### Click as calibration signal

Every user click in any HTTP(S) tab adds a sample (`features,
clientX/innerWidth, clientY/innerHeight`). Same assumption WebGazer uses
("you were looking at what you clicked"). Mousemove samples are not used
— they pull the model toward the cursor trail rather than the gaze.

### Message topology

```
content scripts  ── click/ready ──▶   service worker   ──▶  offscreen doc
                                       (broker +              (model)
                                        storage)
content scripts  ◀── gaze broadcast ── service worker  ◀──   offscreen doc
popup            ──  getStats/reset ──▶ service worker   ──▶ offscreen doc
```

`chrome.runtime.sendMessage` is used everywhere — offscreen → SW → all
tabs. No ports, no named channels (except the one-shot boot handshake
that hydrates state from storage on offscreen startup).

## What's next (not built yet)

- **Phase 2**: when gaze dwells in a region for >1.5s, capture screenshot
  via `chrome.tabs.captureVisibleTab`, crop to the dwell bbox, save to
  IndexedDB with URL + timestamp.
- **Phase 3**: local multimodal model (Gemma via Ollama HTTP on
  `localhost`) analyzes dwelt-on regions at idle, extracts topic tags.
- **Phase 4**: autocomplete in text fields (content-script listener on
  `input`/`textarea`) calls the same local model with the last-N screenshot
  tags as context.

Architectural constraints to preserve: single camera, single model,
all local, never leaves the machine.

## Known caveats

- Content scripts don't run on `chrome://` pages, the Chrome Web Store,
  or new-tab pages. The dot only appears on HTTP(S).
- Camera permission is requested by the offscreen document, not the
  popup. On first use Chrome shows the prompt on whichever tab you
  interact with first. Denying it breaks everything.
- First fit happens at ≥8 samples. Earlier clicks collect silently.
- Accuracy: ≈5–10% of viewport on a well-calibrated session (~30+
  samples). Suitable for *dwell region* tracking in Phase 2, not for
  word-level precision.
