// Content script — runs in every HTTP(S) tab.
// Responsibilities:
//   - Report clicks to the service worker as normalized (nx, ny) pairs so
//     the regression trains on viewport-invariant targets.
//   - Receive normalized gaze predictions broadcast by the background and
//     render a small debug dot in the page when debug mode is on.
// Not on: any page content access / screenshotting / analysis. That's Phase 2+.

(() => {
  const DOT_ID = "__gaze_notes_dot__";
  let debug = false;
  let lastGaze = { nx: null, ny: null };
  let rafId = 0;

  function ensureDot() {
    let el = document.getElementById(DOT_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = DOT_ID;
      el.className = "gaze-notes-dot";
      document.documentElement.appendChild(el);
    }
    return el;
  }
  function removeDot() {
    const el = document.getElementById(DOT_ID);
    if (el) el.remove();
  }

  function renderDot() {
    rafId = 0;
    if (!debug) return;
    if (lastGaze.nx == null) return;
    const el = ensureDot();
    const x = lastGaze.nx * window.innerWidth;
    const y = lastGaze.ny * window.innerHeight;
    el.style.left = x + "px";
    el.style.top  = y + "px";
  }

  // Click reporting — all clicks outside our own overlay become samples
  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === DOT_ID) return;
    const nx = e.clientX / window.innerWidth;
    const ny = e.clientY / window.innerHeight;
    console.log("[gaze-notes/content] click → SW", { nx, ny });
    chrome.runtime.sendMessage({ from: "content", type: "click", nx, ny })
      .then(() => console.log("[gaze-notes/content] SW ack"))
      .catch((err) => console.warn("[gaze-notes/content] send failed", err));
  }, true);
  console.log("[gaze-notes/content] click listener installed on", location.href);

  // Listen for pushed messages from the service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.from !== "bg") return;
    if (msg.type === "gaze") {
      lastGaze = { nx: msg.nx, ny: msg.ny };
      if (!rafId) rafId = requestAnimationFrame(renderDot);
    } else if (msg.type === "setDebug") {
      debug = !!msg.debug;
      if (!debug) removeDot();
    }
  });

  // Announce readiness; get the initial debug flag back
  chrome.runtime.sendMessage({ from: "content", type: "ready" }, (reply) => {
    if (reply && reply.debug) debug = true;
  });
})();
