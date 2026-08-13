import express from "express";
import cors from "cors";
import {
  addAnnotations,
  getAll,
  clear,
  count,
  getBatches,
  saveScreenshot,
  setScreenshotPath,
  getScreenshotPath,
  getPendingCapture,
  setAfterScreenshotPath,
  setAfterTabUrl,
  clearPendingCapture,
  getPendingMode,
  clearPendingMode,
  setModeTabUrl,
} from "./store.js";

const PORT = parseInt(process.env.ANNO_PORT || "3847", 10);

// Runtime HTTP-binding state (in-memory only — NOT part of the file store).
// When another annotation-overlay instance already holds the HTTP port, this
// process keeps its MCP stdio alive and reports the situation via
// read_annotations, so the agent sees it without any manual diagnosis.
const httpBinding = { ownedExternally: false, externalVersion: null };

export function getHttpBindingInfo() {
  return { ...httpBinding };
}

async function probeExternalVersion() {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`);
    const data = await res.json();
    httpBinding.externalVersion = data.version || null;
  } catch {
    httpBinding.externalVersion = null;
  }
}

function generateMarkdown(batches) {
  const lines = [];
  const all = [];
  for (const b of batches) {
    for (const ann of b.annotations) {
      all.push(ann);
    }
  }

  const url = batches.length > 0 ? batches[batches.length - 1].sourceUrl : "unknown";
  lines.push("# Annotation Report");
  lines.push("");
  lines.push("**URL:** " + url);
  lines.push("**Date:** " + new Date().toISOString());
  lines.push("**Total annotations:** " + all.length);
  lines.push("");

  if (all.length === 0) {
    lines.push("_No annotations._");
    return lines.join("\n");
  }

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| # | Type | Comment | Element | Selector |");
  lines.push("|---|------|---------|---------|----------|");
  all.forEach(function (ann, i) {
    var type = ann.type || "unknown";
    var comment = (ann.comment || ann.selectedText || "").substring(0, 60).replace(/\|/g, "\\|").replace(/\n/g, " ");
    var el = (ann.tagName || "").toUpperCase();
    if (ann.classes && ann.classes.length > 0) el += "." + ann.classes[0];
    var selector = (ann.selector || "").substring(0, 50).replace(/\|/g, "\\|");
    lines.push("| " + (i + 1) + " | " + type + " | " + comment + " | " + el + " | `" + selector + "` |");
  });
  lines.push("");

  // Detail section for each annotation
  lines.push("## Details");
  lines.push("");
  all.forEach(function (ann, i) {
    lines.push("### " + (i + 1) + ". " + (ann.type || "unknown"));
    lines.push("");
    if (ann.comment) lines.push("**Comment:** " + ann.comment);
    if (ann.selectedText) lines.push("**Selected text:** \"" + ann.selectedText + "\"");
    if (ann.tagName) lines.push("- **Element:** `<" + ann.tagName.toLowerCase() + ">`");
    if (ann.selector) lines.push("- **Selector:** `" + ann.selector + "`");
    if (ann.contentHash) lines.push("- **Content hash:** `" + ann.contentHash + "`");
    if (ann.color) lines.push("- **Color:** `" + ann.color + "`");
    lines.push("");
    if (ann.fallbackSelectors && ann.fallbackSelectors.length > 0) {
      lines.push("**Fallback selectors:**");
      ann.fallbackSelectors.forEach(function (fs) {
        lines.push("- `" + fs.type + "`: `" + (fs.value || "").substring(0, 80) + "`");
      });
      lines.push("");
    }
  });

  return lines.join("\n");
}

export function createHttpServer() {
  const app = express();
  app.use(cors());
  // 15mb to fit a base64 PNG screenshot dataURL attached to a submit.
  app.use(express.json({ limit: "15mb" }));

  app.post("/api/annotations", (req, res) => {
    try {
      const body = req.body || {};
      // screenshotData is a base64 dataURL of the annotated viewport;
      // persist it to disk and record the path before storing the batch.
      const screenshotData = body.screenshotData;
      const clean = { ...body };
      delete clean.screenshotData;

      let screenshotPath = null;
      if (screenshotData) {
        screenshotPath = saveScreenshot(screenshotData);
        if (screenshotPath) setScreenshotPath(screenshotPath);
      }

      const n = addAnnotations(clean, clean.url);
      res.json({ ok: true, count: n, screenshotPath });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/annotations", (req, res) => {
    const screenshotPath = getScreenshotPath();
    // captureRequest / modeRequest ride along the service worker's existing
    // badge poll so the extension sees pending agent requests without extra
    // calls.
    const captureRequest = getPendingCapture();
    const modeRequest = getPendingMode();
    if (req.query.format === "batches") {
      res.json({ batches: getBatches(), count: count(), screenshotPath, captureRequest, modeRequest });
      return;
    }
    res.json({ count: count(), annotations: getAll(), screenshotPath, captureRequest, modeRequest });
  });

  // The extension posts the captured viewport here after seeing a pending
  // captureRequest in its poll. Saves the screenshot, records it as the "after"
  // state (plus the URL of the tab that was captured), and clears the pending
  // request.
  app.post("/api/capture-result", (req, res) => {
    try {
      const body = req.body || {};
      const path = saveScreenshot(body.screenshotData);
      if (path) {
        setAfterScreenshotPath(path);
        setAfterTabUrl(body.tabUrl);
      }
      clearPendingCapture(body.requestId);
      res.json({ ok: !!path, path, tabUrl: body.tabUrl || null });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // The extension reports an applied annotation-mode change (from the
  // set_annotation_mode MCP tool) after relaying it to the page's overlay.
  app.post("/api/mode-result", (req, res) => {
    try {
      const body = req.body || {};
      if (body.tabUrl) setModeTabUrl(body.tabUrl);
      clearPendingMode(body.requestId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.delete("/api/annotations", (_req, res) => {
    const removed = clear();
    res.json({ ok: true, removed });
  });

  app.post("/api/export/markdown", (req, res) => {
    try {
      const batches = req.body.batches || getBatches();
      const md = generateMarkdown(batches);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"annotations.md\"");
      res.send(md);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: "2.3.0" });
  });

  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log("[annotation-overlay-mcp] HTTP server on port " + PORT);
      resolve(server);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        // Another instance holds the port (e.g. a stale `npm start`, or an
        // orphaned MCP child from an abrupt Claude Code shutdown). Don't crash —
        // keep MCP stdio alive against the shared file store, and surface the
        // situation through read_annotations so the agent sees it automatically.
        httpBinding.ownedExternally = true;
        console.warn(
          `[annotation-overlay-mcp] WARNING: port ${PORT} already in use by another instance — ` +
            "HTTP disabled for this process; MCP tools still run against the shared store. " +
            "read_annotations reports httpOwnedExternally=true. " +
            "Fix: kill the stale process (netstat -ano | grep :" + PORT + "), or ignore if only read/clear are needed."
        );
        probeExternalVersion();
        resolve(null);
      } else {
        console.error("[annotation-overlay-mcp] HTTP listen error:", err.message);
        resolve(null);
      }
    });
  });
}
