// Service worker — broker between content scripts and the offscreen document
// that owns the camera + gaze model. Also: persistent storage for regression
// weights + calibration samples.

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const STORAGE_KEY   = "gazeNotes.state.v1";

let creatingOffscreen = null;

async function hasOffscreenDoc() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDoc()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification:
      "Persistent webcam + MediaPipe face landmarker drive the gaze model shared across tabs.",
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

// Kick the offscreen doc at extension startup and after browser restart so
// camera starts warming up as soon as the user opens a tab.
chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onInstalled.addListener(ensureOffscreen);
// Also on every action click — a safety net in case the SW was killed and
// the offscreen doc with it.
chrome.action.onClicked.addListener(ensureOffscreen);

// ----- Persistence helpers -----
async function loadState() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] || null;
}
async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// ----- Message bus -----
// Messages from offscreen: { from: "offscreen", type: "gaze" | "stats" | "stateSnapshot" }
// Messages from content:   { from: "content",   type: "click" | "viewport" | "toggleDebug" }
// Messages from popup:     { from: "popup",     type: "getStats" | "reset" }
//
// Strategy: offscreen broadcasts gaze ~30Hz; service worker fans out to all
// tabs (chrome.tabs.sendMessage per tab). Clicks from any tab go to SW →
// offscreen. Popup polls for stats.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ensureOffscreen();

    if (msg.from === "offscreen") {
      if (msg.type === "gaze") {
        // Fan out the latest normalized gaze (nx, ny) to every HTTP(S) tab.
        // Content scripts multiply by their own viewport. Tabs that don't
        // host a content script (chrome://, extensions) silently fail.
        const tabs = await chrome.tabs.query({
          url: ["http://*/*", "https://*/*"],
          discarded: false,
        });
        for (const t of tabs) {
          if (!t.id) continue;
          chrome.tabs.sendMessage(t.id, {
            from: "bg", type: "gaze",
            nx: msg.nx, ny: msg.ny, hasModel: msg.hasModel,
          }).catch(() => { /* tab not ready */ });
        }
      } else if (msg.type === "stats") {
        globalThis.__gazeStats = msg.stats;
      } else if (msg.type === "stateSnapshot") {
        // Offscreen is asking us to persist updated state
        await saveState(msg.state);
      } else if (msg.type === "setupError") {
        globalThis.__gazeLastError = msg.error;
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.from === "content") {
      if (msg.type === "click") {
        console.log("[gaze-notes/sw] click from content → fanning out", msg);
        chrome.runtime.sendMessage({
          from: "bg", type: "addSample",
          nx: msg.nx, ny: msg.ny,
        }).then(() => console.log("[gaze-notes/sw] addSample dispatched"))
          .catch((err) => console.warn("[gaze-notes/sw] addSample failed", err));
      } else if (msg.type === "ready") {
        // Content script is hooked up — reply with debug flag
        const state = await loadState();
        sendResponse({ debug: !!(state && state.debug) });
        return;
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.from === "popup") {
      if (msg.type === "getStats") {
        const s = globalThis.__gazeStats || { samples: 0, rmse: null };
        s.lastError = globalThis.__gazeLastError || null;
        sendResponse(s);
        return;
      }
      if (msg.type === "reset") {
        await saveState(null);
        chrome.runtime.sendMessage({ from: "bg", type: "reset" }).catch(() => {});
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "toggleDebug") {
        const state = (await loadState()) || {};
        state.debug = !state.debug;
        await saveState(state);
        // Tell every content script to update
        const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        for (const t of tabs) {
          if (!t.id) continue;
          chrome.tabs.sendMessage(t.id, { from: "bg", type: "setDebug", debug: state.debug })
            .catch(() => {});
        }
        sendResponse({ ok: true, debug: state.debug });
        return;
      }
      if (msg.type === "getDebug") {
        const state = await loadState();
        sendResponse({ debug: !!(state && state.debug) });
        return;
      }
      if (msg.type === "restartOffscreen") {
        // Kill and recreate the offscreen doc so it picks up newly-granted
        // camera permission.
        try { await chrome.offscreen.closeDocument(); } catch (e) {}
        await ensureOffscreen();
        sendResponse({ ok: true });
        return;
      }
    }

    sendResponse({ ok: false, error: "unhandled" });
  })();
  // Keep channel open for async sendResponse
  return true;
});

// Expose: getPersistedState() for offscreen on startup
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "offscreenBoot") {
    loadState().then((state) => {
      port.postMessage({ type: "state", state });
      port.disconnect();
    });
  }
});
