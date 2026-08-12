// bridge.js — ISOLATED world content script
// Injects annotation-overlay.js into MAIN world and bridges postMessage ↔ extension

const ANNO_PORT = 3847;

function isOverlayInjected() {
  return !!document.querySelector("script[data-anno-overlay]");
}

function injectOverlayScript() {
  if (isOverlayInjected()) return;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("annotation-overlay.js");
  script.dataset.annoOverlay = "";
  script.onload = () => {
    script.remove();
    window.postMessage({ type: "anno-config", port: ANNO_PORT }, "*");
  };
  script.onerror = () => {
    script.remove();
    console.warn("[AnnotationOverlay] Failed to load overlay script");
  };
  (document.head || document.documentElement).appendChild(script);
}

// SW → ISOLATED world → MAIN world: agent-initiated annotation mode control
// (the set_annotation_mode MCP tool is relayed by the service worker's poll).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "anno-set-mode") {
    window.postMessage(
      { type: "anno-set-mode", enabled: message.enabled, requestId: message.requestId },
      "*"
    );
    sendResponse({ ok: true });
  }
});

// MAIN world → ISOLATED world: receive annotation batch
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "anno-submit") {
    const payload = event.data.payload;
    try {
      const res = await fetch(
        `http://localhost:${ANNO_PORT}/api/annotations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json();
      chrome.runtime.sendMessage({
        type: "badge-update",
        count: data.count,
      });
      window.postMessage(
        { type: "anno-submitted", ok: true, count: data.count },
        "*"
      );
    } catch (err) {
      window.postMessage(
        { type: "anno-submitted", ok: false, error: err.message },
        "*"
      );
    }
  }

  if (event.data?.type === "anno-capture") {
    // Forward screenshot request to service worker (captureVisibleTab is not
    // available in content scripts), then relay the dataURL back to MAIN world.
    chrome.runtime.sendMessage({ type: "anno-capture" }, (resp) => {
      window.postMessage(
        {
          type: "anno-captured",
          ok: resp?.ok ?? false,
          dataURL: resp?.dataUrl,
          error: resp?.error,
        },
        "*"
      );
    });
  }

  if (event.data?.type === "anno-export") {
    const { format, payload } = event.data;
    if (format === "markdown") {
      try {
        const res = await fetch(
          `http://localhost:${ANNO_PORT}/api/export/markdown`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }
        );
        const md = await res.text();
        window.postMessage(
          { type: "anno-exported", format: "markdown", data: md },
          "*"
        );
      } catch (err) {
        window.postMessage(
          { type: "anno-exported", format: "markdown", error: err.message },
          "*"
        );
      }
    }
  }
});

// Get initial badge count from service worker
chrome.runtime.sendMessage({ type: "get-count" }, (response) => {
  if (response?.count !== undefined) {
    window.postMessage({ type: "anno-count", count: response.count }, "*");
  }
});

// SPA route change detection
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    setTimeout(injectOverlayScript, 500);
  }
}).observe(document, { subtree: true, childList: true });

// Inject on load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectOverlayScript);
} else {
  injectOverlayScript();
}
