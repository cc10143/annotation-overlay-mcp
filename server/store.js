// In-memory annotation store for MVP.
// Annotations live only until read+cleared by the agent (synchronous workflow).
// File persistence can be added later.

const annotations = [];

export function addAnnotations(batch, sourceUrl) {
  const items = batch.annotations || [batch];
  for (const ann of items) {
    annotations.push({
      ...ann,
      _receivedAt: new Date().toISOString(),
      _sourceUrl: sourceUrl || batch.url || "unknown",
      _batchId: batch.id || crypto.randomUUID(),
    });
  }
  return annotations.length;
}

export function getAll() {
  return [...annotations];
}

export function clear() {
  const count = annotations.length;
  annotations.length = 0;
  return count;
}

export function count() {
  return annotations.length;
}
