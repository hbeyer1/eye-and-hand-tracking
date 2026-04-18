// Offscreen document — owns the webcam, MediaPipe FaceLandmarker, and the
// gaze ridge-regression model. Broadcasts normalized gaze predictions to
// the service worker which fans them out to every HTTP(S) tab.

import { FaceLandmarker, FilesetResolver } from "./vendor/mediapipe/vision_bundle.mjs";

// ============================================================
// Config
// ============================================================
const PATCH_W = 40, PATCH_H = 20;
const PIXELS_PER_EYE = PATCH_W * PATCH_H;                // 800
const TOTAL_PIXELS   = PIXELS_PER_EYE * 2;               // 1600
const POSE_DIMS      = 3;
const D              = TOTAL_PIXELS + POSE_DIMS + 1;     // + bias = 1604
const POSE_SCALE     = 1.0;
const LAMBDA_DEFAULT = 0.5;

const LEFT_IDX  = { outer: 33,  inner: 133, top: 159, bot: 145 };
const RIGHT_IDX = { inner: 362, outer: 263, top: 386, bot: 374 };

// ============================================================
// DOM
// ============================================================
const video  = document.getElementById("webcam");
const patchL = document.getElementById("patchL");
const patchR = document.getElementById("patchR");
const pLctx  = patchL.getContext("2d", { willReadFrequently: true });
const pRctx  = patchR.getContext("2d", { willReadFrequently: true });

// ============================================================
// State
// ============================================================
let faceLandmarker = null;
let lastTime = -1;
let curFeat = null;
let curPose = null;

// Regression state (ridge in dual formulation — samples-limited)
const samples = { X: [], ys: [], yt: [] };  // features, normX target, normY target
let wx = null, wy = null;                   // fitted weights (Float32Array of length D)
let lambda = LAMBDA_DEFAULT;

// Streaming online RMSE
const stream = { sum: 0, n: 0 };

let lastBroadcastAt = 0;
const BROADCAST_INTERVAL_MS = 1000 / 30; // ~30 Hz

// ============================================================
// Bootstrap: fetch persisted state from SW, then init
// ============================================================
const bootPort = chrome.runtime.connect({ name: "offscreenBoot" });
bootPort.onMessage.addListener((msg) => {
  if (msg.type === "state" && msg.state) {
    try {
      if (Array.isArray(msg.state.samples)) {
        for (const s of msg.state.samples) {
          samples.X.push(Float32Array.from(s.f));
          samples.ys.push(s.nx);
          samples.yt.push(s.ny);
        }
        if (samples.X.length >= 8) refit();
      }
      if (typeof msg.state.lambda === "number") lambda = msg.state.lambda;
    } catch (e) { console.warn("failed to hydrate state", e); }
  }
  setup().catch(err => console.error("offscreen setup failed", err));
});

// ============================================================
// Setup MediaPipe + camera
// ============================================================
async function setup() {
  const fileset = await FilesetResolver.forVisionTasks(
    chrome.runtime.getURL("vendor/mediapipe/wasm")
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL("vendor/mediapipe/model/face_landmarker.task"),
      delegate: "GPU",
    },
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
    runningMode: "VIDEO",
    numFaces: 1,
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((r) => (video.onloadedmetadata = r));
  await video.play();

  requestAnimationFrame(loop);
}

// ============================================================
// Main loop: detect face, build features, predict, broadcast
// ============================================================
function loop() {
  const now = performance.now();
  if (video.readyState >= 2 && video.currentTime !== lastTime) {
    lastTime = video.currentTime;
    const res = faceLandmarker.detectForVideo(video, now);
    computeFeatures(res);
    if (now - lastBroadcastAt >= BROADCAST_INTERVAL_MS) {
      lastBroadcastAt = now;
      broadcastGaze();
      sendStats();
    }
  }
  requestAnimationFrame(loop);
}

// ============================================================
// Feature extraction
// ============================================================
function computeFeatures(res) {
  const lm = res.faceLandmarks && res.faceLandmarks[0];
  if (!lm) { curFeat = null; return; }
  const W = video.videoWidth, H = video.videoHeight;
  extractRectifiedPatch(lm, LEFT_IDX,  pLctx, W, H);
  extractRectifiedPatch(lm, RIGHT_IDX, pRctx, W, H);

  const feat = new Float32Array(D);
  const dL = pLctx.getImageData(0, 0, PATCH_W, PATCH_H).data;
  const dR = pRctx.getImageData(0, 0, PATCH_W, PATCH_H).data;
  const inv255 = 1 / 255;
  for (let i = 0, j = 0; i < dL.length; i += 4, j++) {
    feat[j] = (dL[i] * 0.299 + dL[i+1] * 0.587 + dL[i+2] * 0.114) * inv255;
  }
  for (let i = 0, j = PIXELS_PER_EYE; i < dR.length; i += 4, j++) {
    feat[j] = (dR[i] * 0.299 + dR[i+1] * 0.587 + dR[i+2] * 0.114) * inv255;
  }
  const m = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
  curPose = m ? matrixToEuler(m) : { yaw: 0, pitch: 0, roll: 0 };
  const PI_Q = Math.PI / 4;
  feat[TOTAL_PIXELS    ] = (curPose.yaw   / PI_Q) * POSE_SCALE;
  feat[TOTAL_PIXELS + 1] = (curPose.pitch / PI_Q) * POSE_SCALE;
  feat[TOTAL_PIXELS + 2] = (curPose.roll  / PI_Q) * POSE_SCALE;
  feat[TOTAL_PIXELS + 3] = 1;
  curFeat = feat;
}

function extractRectifiedPatch(lm, idx, ctx, W, H) {
  const p = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const a = p(idx.outer), b = p(idx.inner);
  const [from, to] = a.x < b.x ? [a, b] : [b, a];
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x, dy = to.y - from.y;
  const eyeLen = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const inset = 4;
  const targetLen = PATCH_W - 2 * inset;
  const scale = targetLen / eyeLen;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, PATCH_W, PATCH_H);
  ctx.translate(PATCH_W / 2, PATCH_H / 2);
  ctx.scale(scale, scale);
  ctx.rotate(-angle);
  ctx.translate(-midX, -midY);
  ctx.drawImage(video, 0, 0);
  ctx.restore();
}

function matrixToEuler(mat) {
  const m = mat.data;
  const sy = Math.sqrt(m[0]*m[0] + m[1]*m[1]);
  const singular = sy < 1e-6;
  let x, y, z;
  if (!singular) {
    x = Math.atan2(m[6],  m[10]);
    y = Math.atan2(-m[2], sy);
    z = Math.atan2(m[1],  m[0]);
  } else {
    x = Math.atan2(-m[9], m[5]);
    y = Math.atan2(-m[2], sy);
    z = 0;
  }
  return { pitch: x, yaw: y, roll: z };
}

// ============================================================
// Prediction + broadcast
// ============================================================
function dot(a, b) {
  let s = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function broadcastGaze() {
  if (!curFeat || !wx || !wy) {
    chrome.runtime.sendMessage({
      from: "offscreen", type: "gaze", nx: null, ny: null, hasModel: false,
    }).catch(() => {});
    return;
  }
  const nx = clamp01(dot(curFeat, wx));
  const ny = clamp01(dot(curFeat, wy));
  chrome.runtime.sendMessage({
    from: "offscreen", type: "gaze", nx, ny, hasModel: true,
  }).catch(() => {});
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function sendStats() {
  const rmse_norm = stream.n ? stream.sum / stream.n : null;
  chrome.runtime.sendMessage({
    from: "offscreen", type: "stats",
    stats: {
      samples: samples.X.length,
      // RMSE reported as normalized units (0-1); a caller converts with
      // viewport if they want px. Normalized is tab-invariant.
      rmseNormalized: rmse_norm,
      hasModel: !!(wx && wy),
    },
  }).catch(() => {});
}

// ============================================================
// Ridge regression (dual form — efficient when n < d)
//   w = X^T (X X^T + λI)^-1 y
// ============================================================
function refit() {
  const n = samples.X.length;
  if (n < 4) return;
  const d = samples.X[0].length;

  const K = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const xi = samples.X[i];
    for (let j = i; j < n; j++) {
      const xj = samples.X[j];
      let s = 0;
      for (let k = 0; k < d; k++) s += xi[k] * xj[k];
      K[i*n + j] = s;
      K[j*n + i] = s;
    }
  }
  for (let i = 0; i < n; i++) K[i*n + i] += lambda;

  const K1 = new Float64Array(K);
  const ax = gaussSolve(K1, Float64Array.from(samples.ys), n);
  const K2 = new Float64Array(K);
  const ay = gaussSolve(K2, Float64Array.from(samples.yt), n);
  if (!ax || !ay) return;

  const wxN = new Float32Array(d);
  const wyN = new Float32Array(d);
  for (let i = 0; i < n; i++) {
    const xi = samples.X[i];
    const cx = ax[i], cy = ay[i];
    for (let k = 0; k < d; k++) {
      wxN[k] += xi[k] * cx;
      wyN[k] += xi[k] * cy;
    }
  }
  wx = wxN; wy = wyN;
}

function gaussSolve(A, b, n) {
  const x = new Float64Array(b);
  for (let i = 0; i < n; i++) {
    let p = i, pv = Math.abs(A[i*n + i]);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(A[r*n + i]);
      if (v > pv) { pv = v; p = r; }
    }
    if (pv < 1e-10) return null;
    if (p !== i) {
      for (let c = i; c < n; c++) {
        const t = A[i*n + c]; A[i*n + c] = A[p*n + c]; A[p*n + c] = t;
      }
      const t = x[i]; x[i] = x[p]; x[p] = t;
    }
    const piv = A[i*n + i];
    for (let r = i + 1; r < n; r++) {
      const f = A[r*n + i] / piv;
      if (f === 0) continue;
      for (let c = i; c < n; c++) A[r*n + c] -= f * A[i*n + c];
      x[r] -= f * x[i];
    }
  }
  const out = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let c = i + 1; c < n; c++) s -= A[i*n + c] * out[c];
    out[i] = s / A[i*n + i];
  }
  return out;
}

// ============================================================
// Receive addSample / reset from service worker
// ============================================================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.from === "bg" && msg.type === "addSample") {
    if (!curFeat) return;
    // Predict-before-train for online eval
    if (wx && wy) {
      const pnx = clamp01(dot(curFeat, wx));
      const pny = clamp01(dot(curFeat, wy));
      const err = Math.hypot(msg.nx - pnx, msg.ny - pny);
      stream.sum += err;
      stream.n += 1;
    }
    const f = new Float32Array(curFeat);
    samples.X.push(f);
    samples.ys.push(msg.nx);
    samples.yt.push(msg.ny);
    if (samples.X.length >= 8) refit();
    persist();
    sendStats();
  } else if (msg.from === "bg" && msg.type === "reset") {
    samples.X.length = 0;
    samples.ys.length = 0;
    samples.yt.length = 0;
    wx = null; wy = null;
    stream.sum = 0; stream.n = 0;
    persist();
    sendStats();
  }
});

// Persist collected samples + λ. We don't persist wx/wy because they're
// derived — if the user reopens, we refit from samples, which is fast enough.
function persist() {
  const state = {
    lambda,
    samples: samples.X.map((f, i) => ({
      // Float32Array → plain array for chrome.storage JSON-round-trip.
      f: Array.from(f),
      nx: samples.ys[i],
      ny: samples.yt[i],
    })),
  };
  chrome.runtime.sendMessage({
    from: "offscreen", type: "stateSnapshot", state,
  }).catch(() => {});
}
