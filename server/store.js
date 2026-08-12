// File-persistent annotation store.
// Data survives MCP server restarts at ~/.annotation-overlay/annotations.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STORE_DIR = join(homedir(), ".annotation-overlay");
const STORE_FILE = join(STORE_DIR, "annotations.json");
const SCREENSHOT_DIR = join(STORE_DIR, "screenshots");

function ensureDir() {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
  if (!existsSync(SCREENSHOT_DIR)) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDir();
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { batches: [] };
  }
}

function writeStore(data) {
  ensureDir();
  writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function addAnnotations(batch, sourceUrl) {
  const store = readStore();
  const batchId = batch.id || crypto.randomUUID();
  const items = (batch.annotations || [batch]).map((ann) => ({
    ...ann,
    _receivedAt: new Date().toISOString(),
    _sourceUrl: sourceUrl || batch.url || "unknown",
    _batchId: batchId,
  }));

  store.batches.push({
    id: batchId,
    sourceUrl: sourceUrl || batch.url || "unknown",
    receivedAt: new Date().toISOString(),
    annotations: items,
  });

  writeStore(store);
  return countAll(store);
}

export function getAll() {
  const store = readStore();
  const all = [];
  for (const b of store.batches) {
    for (const ann of b.annotations) {
      all.push(ann);
    }
  }
  return all;
}

export function getBatches() {
  return readStore().batches;
}

export function clear() {
  const store = readStore();
  const n = countAll(store);
  store.batches = [];
  // Screenshot paths and pending capture belong to the cleared feedback round —
  // reset them too so read_annotations doesn't return stale/removed images and
  // the extension doesn't act on a stale capture request.
  store.lastScreenshotPath = null;
  store.lastAfterScreenshotPath = null;
  store.lastAfterTabUrl = null;
  store.lastModeTabUrl = null;
  store.pendingCapture = null;
  store.pendingMode = null;
  writeStore(store);
  return n;
}

export function count() {
  return countAll(readStore());
}

// Save a base64 dataURL screenshot to ~/.annotation-overlay/screenshots/.
// Returns the absolute file path, or null if the data is empty/invalid.
export function saveScreenshot(dataURL) {
  ensureDir();
  const base64 = String(dataURL || "").replace(/^data:image\/\w+;base64,/, "");
  if (!base64) return null;
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  const file = join(SCREENSHOT_DIR, "anno-" + ts + ".png");
  writeFileSync(file, buf);
  return file;
}

// Track the most recent screenshot so read_annotations can surface its path.
// Persisted in the store file so it survives server restarts.
export function setScreenshotPath(p) {
  const store = readStore();
  store.lastScreenshotPath = p || null;
  writeStore(store);
}

export function getScreenshotPath() {
  return readStore().lastScreenshotPath || null;
}

// Pending capture request — set by the MCP capture_page tool, read by the
// extension's service-worker poll, cleared when the capture result arrives.
export function setPendingCapture(id) {
  const store = readStore();
  store.pendingCapture = { id, ts: new Date().toISOString() };
  writeStore(store);
}

export function getPendingCapture() {
  return readStore().pendingCapture || null;
}

// Clear the pending request. When an id is given, only clear if it matches the
// current pending request — so a stale capture result can't cancel a newer one.
export function clearPendingCapture(id) {
  const store = readStore();
  if (store.pendingCapture && (!id || store.pendingCapture.id === id)) {
    store.pendingCapture = null;
    writeStore(store);
  }
}

// The "after" screenshot — clean page capture requested by the agent for
// before/after verification (as opposed to lastScreenshotPath, which is the
// annotated "before" viewport saved on Submit).
export function setAfterScreenshotPath(p) {
  const store = readStore();
  store.lastAfterScreenshotPath = p || null;
  writeStore(store);
}

export function getAfterScreenshotPath() {
  return readStore().lastAfterScreenshotPath || null;
}

// URL of the tab that produced the "after" capture. Lets the agent verify the
// capture actually shows the page it expected (active-tab capture can hit a
// different tab if the user switched away).
export function setAfterTabUrl(p) {
  const store = readStore();
  store.lastAfterTabUrl = p || null;
  writeStore(store);
}

export function getAfterTabUrl() {
  return readStore().lastAfterTabUrl || null;
}

// Pending annotation-mode change — set by the MCP set_annotation_mode tool, read
// by the extension's service-worker poll (relays to the page's overlay), cleared
// when the mode-result arrives. Returns the generated id for the tool to wait on.
export function setPendingMode(enabled) {
  const store = readStore();
  const id = crypto.randomUUID();
  store.pendingMode = { id, enabled: !!enabled, ts: new Date().toISOString() };
  writeStore(store);
  return id;
}

export function getPendingMode() {
  return readStore().pendingMode || null;
}

export function clearPendingMode(id) {
  const store = readStore();
  if (store.pendingMode && (!id || store.pendingMode.id === id)) {
    store.pendingMode = null;
    writeStore(store);
  }
}

// URL of the tab the mode change was applied to (for the agent to verify it
// activated on the right page).
export function setModeTabUrl(p) {
  const store = readStore();
  store.lastModeTabUrl = p || null;
  writeStore(store);
}

export function getModeTabUrl() {
  return readStore().lastModeTabUrl || null;
}

function countAll(store) {
  let n = 0;
  for (const b of store.batches) {
    n += b.annotations.length;
  }
  return n;
}
