// service-worker.js — badge management and message relay

const ANNO_PORT = 3847;
const POLL_INTERVAL = 10000;

async function fetchCount() {
  try {
    const res = await fetch(`http://localhost:${ANNO_PORT}/api/annotations`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.count;
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

async function refreshBadge() {
  const c = await fetchCount();
  updateBadge(c);
}

// Listen for bridge messages
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "badge-update") {
    updateBadge(message.count);
    sendResponse({ ok: true });
  } else if (message.type === "get-count") {
    fetchCount()
      .then((c) => sendResponse({ count: c ?? 0 }))
      .catch(() => sendResponse({ count: 0 }));
    return true; // async response
  }
});

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);

setInterval(refreshBadge, POLL_INTERVAL);
refreshBadge();
