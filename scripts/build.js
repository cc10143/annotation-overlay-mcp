// Copy src/annotation-overlay.js to extension/ for Chrome extension
import { copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const src = join(root, "src", "annotation-overlay.js");
const dest = join(root, "extension", "annotation-overlay.js");

copyFileSync(src, dest);
console.log("[build] Copied annotation-overlay.js → extension/");
