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
    s.hasModel ? "trained" : "warming up";
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

refresh();
setInterval(refresh, 500);
