// Generate minimal PNG icons (16×16, 48×48, 128×128)
// Uses a "+" symbol on a circular background — Catppuccin Mocha theme.
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { deflateSync } = require("node:zlib");

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "..", "extension", "icons");

// Minimal PNG encoder — generates a valid PNG file from raw RGBA pixel data.
// This avoids dependencies on sharp/canvas for simple solid-color icons.

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(8 + len + 4);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, "ascii");
  data.copy(buf, 8);
  const crcData = Buffer.alloc(4 + len);
  buf.copy(crcData, 0, 4, 8 + len);
  buf.writeUInt32BE(crc32(crcData), 8 + len);
  return buf;
}

function makePng(size) {
  // Colors: Catppuccin Mocha surface + green accent
  const bgR = 0x1e, bgG = 0x1e, bgB = 0x2e;
  const fgR = 0xa6, fgG = 0xe3, fgB = 0xa1;

  // Build RGBA pixel data (row by row, bottom to top)
  const center = size / 2;
  const radius = size * 0.35;
  const barW = size * 0.13;
  const barH = size * 0.36;

  const rawData = Buffer.alloc(size * size * 4 + size); // +size for filter bytes
  let offset = 0;

  for (let y = 0; y < size; y++) {
    rawData[offset++] = 0; // filter: none

    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Circular background
      const inCircle = dist <= radius;
      // "+" cross: horizontal and vertical bars
      const inH = Math.abs(dy) < barW && Math.abs(dx) < barH;
      const inV = Math.abs(dx) < barW && Math.abs(dy) < barH;
      const isFg = inCircle && (inH || inV);

      if (isFg) {
        rawData[offset++] = fgR;
        rawData[offset++] = fgG;
        rawData[offset++] = fgB;
        rawData[offset++] = 255;
      } else if (inCircle) {
        rawData[offset++] = bgR;
        rawData[offset++] = bgG;
        rawData[offset++] = bgB;
        rawData[offset++] = 255;
      } else {
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
      }
    }
  }

  // Build IDAT: zlib-compress the raw filtered data
  const compressed = deflateSync(rawData);

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const chunks = [
    createChunk("IHDR", ihdr),
    createChunk("IDAT", compressed),
    createChunk("IEND", Buffer.alloc(0)),
  ];

  return Buffer.concat([signature, ...chunks]);
}

// Generate all three icon sizes
[16, 48, 128].forEach((size) => {
  const png = makePng(size);
  const path = join(iconsDir, `icon${size}.png`);
  writeFileSync(path, png);
  console.log(`[icons] Generated icon${size}.png (${png.length} bytes)`);
});
