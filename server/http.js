import express from "express";
import cors from "cors";
import { addAnnotations, getAll, clear, count } from "./store.js";

const PORT = parseInt(process.env.ANNO_PORT || "3847", 10);

export function createHttpServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.post("/api/annotations", (req, res) => {
    try {
      const n = addAnnotations(req.body, req.body.url);
      res.json({ ok: true, count: n });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/annotations", (_req, res) => {
    res.json({ count: count(), annotations: getAll() });
  });

  app.delete("/api/annotations", (_req, res) => {
    const removed = clear();
    res.json({ ok: true, removed });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: "2.0.0" });
  });

  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`[annotation-overlay-mcp] HTTP server on port ${PORT}`);
      resolve(server);
    });
  });
}
