/**
 * Generates icons/icon{16,32,48,128}.png — no dependencies, pure Node.
 *
 * Design: a blue→violet gradient rounded square with the classic
 * "copy" glyph — two overlapping sheets with text lines.
 *
 * Shapes are rasterized at 384×384 (divisible by all target sizes) with a
 * supersampled rounded-rect test, then box-filtered down for smooth edges.
 *
 * Run:  node tools/make-icons.js
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- PNG encode

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- rasterizer

const MASTER = 384;
const canvas = new Float64Array(MASTER * MASTER * 4); // straight RGBA, 0-255

function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px >= x + w || py < y || py >= y + h) return false;
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Composites `src` over `dst` (both [r,g,b,a], 0-255) and returns the result. */
function over(dst, src) {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return [0, 0, 0, 0];
  return [
    (src[0] * sa + dst[0] * da * (1 - sa)) / oa,
    (src[1] * sa + dst[1] * da * (1 - sa)) / oa,
    (src[2] * sa + dst[2] * da * (1 - sa)) / oa,
    oa * 255,
  ];
}

/** Paints a rounded rect (optionally a vertical gradient) with 2x2 supersampling. */
function paintRoundedRect(x, y, w, h, r, colorTop, colorBottom, alpha) {
  for (let py = Math.floor(y); py < y + h; py++) {
    for (let px = Math.floor(x); px < x + w; px++) {
      let cov = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        if (inRoundedRect(px + ox, py + oy, x, y, w, h, r)) cov += 0.25;
      }
      if (cov === 0) continue;
      const t = h > 1 ? (py - y) / (h - 1) : 0;
      const base = [
        colorTop[0] + (colorBottom[0] - colorTop[0]) * t,
        colorTop[1] + (colorBottom[1] - colorTop[1]) * t,
        colorTop[2] + (colorBottom[2] - colorTop[2]) * t,
      ];
      const idx = (py * MASTER + px) * 4;
      const src = [base[0], base[1], base[2], 255 * alpha * cov];
      const res = over(
        [canvas[idx], canvas[idx + 1], canvas[idx + 2], canvas[idx + 3]],
        src
      );
      canvas[idx] = res[0];
      canvas[idx + 1] = res[1];
      canvas[idx + 2] = res[2];
      canvas[idx + 3] = res[3];
    }
  }
}

// ------------------------------------------------------------------- artwork

const BLUE = [59, 130, 246];    // #3B82F6
const VIOLET = [139, 92, 246];  // #8B5CF6
const WHITE = [255, 255, 255];

paintRoundedRect(0, 0, 384, 384, 86, BLUE, VIOLET, 1);        // background
paintRoundedRect(140, 76, 170, 210, 24, WHITE, WHITE, 0.45);  // back sheet
paintRoundedRect(84, 110, 170, 210, 24, WHITE, WHITE, 1);     // front sheet
paintRoundedRect(112, 148, 114, 16, 8, BLUE, BLUE, 0.85);     // text line 1
paintRoundedRect(112, 188, 114, 16, 8, BLUE, BLUE, 0.85);     // text line 2
paintRoundedRect(112, 228, 76, 16, 8, BLUE, BLUE, 0.85);      // text line 3

// ---------------------------------------------------------------- downsample

function downsample(size) {
  const step = MASTER / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * step); sy < (y + 1) * step; sy++) {
        for (let sx = Math.floor(x * step); sx < (x + 1) * step; sx++) {
          const idx = (sy * MASTER + sx) * 4;
          r += canvas[idx];
          g += canvas[idx + 1];
          b += canvas[idx + 2];
          a += canvas[idx + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, size, downsample(size));
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
