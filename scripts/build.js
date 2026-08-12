// Copy src/annotation-overlay.js to extension/ (for Chrome extension) and
// root (standalone injection via script tag / Tandem evaluate).
// Root mirrors src so the standalone copy never drifts behind.
import { copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const src = join(root, "src", "annotation-overlay.js");

const extDest = join(root, "extension", "annotation-overlay.js");
const rootDest = join(root, "annotation-overlay.js");

copyFileSync(src, extDest);
copyFileSync(src, rootDest);
console.log("[build] Copied annotation-overlay.js → extension/ + root/");
