// service-worker.js — badge management, agent-requested capture, message relay

const ANNO_PORT = 3847;
const POLL_INTERVAL = 10000;

// Id of the last pending capture request we acted on. Guards against the 10s
// poll re-capturing before the server clears the pending flag.
let lastCaptureRequestId = null;

async function fetchState() {
  try {
    const res = await fetch(`http://localhost:${ANNO_PORT}/api/annotations`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return null;
  }
}

function updateBadge(count) {
  if (count === null) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(Math.min(count, 999)) });
    chrome.action.setBadgeBackgroundColor({ color: "#e94560" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// Capture the active tab when the server holds a pending agent-requested
// capture (set by the MCP capture_page tool). The server sends `captureRequest`
// as null when idle, or `{ id, ts }` when pending — its presence IS the request.
// The extension has <all_urls> host permission, so captureVisibleTab works here
// without a user gesture — unlike the activeTab-granted path used on Submit.
async function handleCaptureRequest(req) {
  if (!req || !req.id) return;
  if (req.id === lastCaptureRequestId) return; // already handled / in flight
  lastCaptureRequestId = req.id;

  let win;
  try {
    win = await chrome.windows.getLastFocused();
  } catch {
    lastCaptureRequestId = null; // allow retry next poll
    return;
  }

  let tabId, tabUrl;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    tabId = tab && tab.id;
    tabUrl = tab && tab.url;
  } catch {}
  if (!tabId) {
    lastCaptureRequestId = null; // allow retry next poll
    return;
  }

  // Hide the annotation overlay (it auto-activates on extension injection, so
  // the toolbar/canvas/badges would pollute a clean "after" shot), capture the
  // active tab, then restore the overlay. captureVisibleTab works without a user
  // gesture here because the extension has <all_urls> host permission (unlike
  // the activeTab-granted path used on Submit).
  const hideCss =
    "#__anno_toolbar,#__anno_comment,#__anno_shortcuts,#__anno_canvas,.__anno_badge{display:none!important}";
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, css: hideCss });
  } catch {}
  await new Promise((r) => setTimeout(r, 100)); // let the CSS apply before capture

  chrome.tabs.captureVisibleTab(win.id, { format: "png" }, async (dataUrl) => {
    try {
      await chrome.scripting.removeCSS({ target: { tabId }, css: hideCss });
    } catch {}
    if (chrome.runtime.lastError || !dataUrl) {
      lastCaptureRequestId = null; // allow retry next poll
      return;
    }
    try {
      const res = await fetch(`http://localhost:${ANNO_PORT}/api/capture-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: req.id, screenshotData: dataUrl, tabUrl }),
      });
      if (!res.ok) lastCaptureRequestId = null; // retry next poll
      // on success the server clears pendingCapture; nothing further to do
    } catch {
      lastCaptureRequestId = null; // retry next poll
    }
  });
}

async function refreshBadge() {
  const data = await fetchState();
  updateBadge(data ? data.count : null);
  if (data) handleCaptureRequest(data.captureRequest);
}

// Listen for bridge messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "badge-update") {
    updateBadge(message.count);
    sendResponse({ ok: true });
  } else if (message.type === "get-count") {
    fetchState()
      .then((data) => sendResponse({ count: data ? data.count : 0 }))
      .catch(() => sendResponse({ count: 0 }));
    return true; // async response
  } else if (message.type === "anno-capture") {
    // Capture the current visible tab (page + overlay annotations rendered in
    // DOM). The overlay hides its own toolbar before requesting the capture, but
    // there's a paint race — captureVisibleTab may snapshot the frame before the
    // display:none commits. Hide the toolbar trio via CSS with a short wait for a
    // deterministic clean shot; badges/canvas stay visible (they are the point of
    // the "before" screenshot).
    const tab = sender.tab;
    const tabId = tab && tab.id;
    const hideCss = "#__anno_toolbar,#__anno_comment,#__anno_shortcuts{display:none!important}";
    (async () => {
      let hidden = false;
      if (tabId) {
        try {
          await chrome.scripting.insertCSS({ target: { tabId }, css: hideCss });
          hidden = true;
          await new Promise((r) => setTimeout(r, 100));
        } catch {}
      }
      const windowId = tab ? tab.windowId : undefined;
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }, async (dataUrl) => {
        if (hidden) {
          try {
            await chrome.scripting.removeCSS({ target: { tabId }, css: hideCss });
          } catch {}
        }
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, dataUrl });
        }
      });
    })();
    return true; // async response
  }
});

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);

setInterval(refreshBadge, POLL_INTERVAL);
refreshBadge();
