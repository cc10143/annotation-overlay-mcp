// File-persistent annotation store.
// Data survives MCP server restarts at ~/.annotation-overlay/annotations.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STORE_DIR = join(homedir(), ".annotation-overlay");
const STORE_FILE = join(STORE_DIR, "annotations.json");

function ensureDir() {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
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
  writeStore(store);
  return n;
}

export function count() {
  return countAll(readStore());
}

function countAll(store) {
  let n = 0;
  for (const b of store.batches) {
    n += b.annotations.length;
  }
  return n;
}
