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
  // Screenshot path belongs to the cleared feedback round — reset it too so
  // read_annotations doesn't return a path to a stale/removed image.
  store.lastScreenshotPath = null;
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

function countAll(store) {
  let n = 0;
  for (const b of store.batches) {
    n += b.annotations.length;
  }
  return n;
}
