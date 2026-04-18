function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refresh() {
  const s = await send({ from: "popup", type: "getStats" });
  if (!s) return;
  document.getElementById("samples").textContent = s.samples ?? 0;
  document.getElementById("rmse").textContent =
    s.rmseNormalized == null ? "—" : s.rmseNormalized.toFixed(3);
  document.getElementById("has-model").textContent =
    s.hasModel ? "trained" : (s.lastError ? "error" : "warming up");
  if (s.lastError) {
    const hint = document.getElementById("grant-hint");
    hint.innerHTML = `<b>Setup error:</b> ${s.lastError}`;
  }
  const d = await send({ from: "popup", type: "getDebug" });
  document.getElementById("debug-state").textContent = d && d.debug ? "on" : "off";
}

document.getElementById("toggle-debug").addEventListener("click", async () => {
  await send({ from: "popup", type: "toggleDebug" });
  refresh();
});
document.getElementById("reset").addEventListener("click", async () => {
  if (!confirm("Clear all calibration samples + weights?")) return;
  await send({ from: "popup", type: "reset" });
  refresh();
});

// Explicit permission flow — the offscreen document can't reliably surface
// a permission prompt by itself (it's invisible). Asking from a popup
// that's a user-gesture context guarantees Chrome shows the prompt.
// We immediately stop the stream — we only needed the prompt to fire so
// the permission is cached for the extension origin.
document.getElementById("grant-camera").addEventListener("click", async () => {
  const btn = document.getElementById("grant-camera");
  const hint = document.getElementById("grant-hint");
  btn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach(t => t.stop());
    hint.textContent = "Camera granted. Reloading the offscreen document…";
    await send({ from: "popup", type: "restartOffscreen" });
    setTimeout(refresh, 1500);
  } catch (e) {
    hint.textContent = "Permission failed: " + (e && e.message || e);
    btn.disabled = false;
  }
});

refresh();
setInterval(refresh, 500);
