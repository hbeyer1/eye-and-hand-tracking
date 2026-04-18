const btn    = document.getElementById("grant");
const status = document.getElementById("status");

btn.addEventListener("click", async () => {
  status.className = "";
  status.textContent = "Requesting camera…";
  btn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    status.className = "ok";
    status.textContent = "Granted. Restarting the offscreen document…";
    await new Promise((r) => chrome.runtime.sendMessage(
      { from: "popup", type: "restartOffscreen" }, r
    ));
    status.textContent = "Done. You can close this tab.";
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    status.className = "err";
    const name = e && e.name    ? e.name    : "Error";
    const msg  = e && e.message ? e.message : "";
    status.textContent = `${name}: ${msg}`;
    btn.disabled = false;
  }
});
