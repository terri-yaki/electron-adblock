import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = path.join(root, 'assets');
fs.mkdirSync(assets, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    rgba.copy(row, 1, y * width * 4, (y + 1) * width * 4);
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hex(value) {
  const clean = value.replace('#', '');
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

function insidePolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function insideRoundedRect(px, py, size, radius) {
  const r = radius;
  const cx = Math.min(Math.max(px, r), size - r);
  const cy = Math.min(Math.max(py, r), size - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

const shield = [
  [0.22, 0.145],
  [0.5, 0.09],
  [0.78, 0.145],
  [0.78, 0.47],
  [0.72, 0.62],
  [0.62, 0.75],
  [0.5, 0.9],
  [0.38, 0.75],
  [0.28, 0.62],
  [0.22, 0.47],
];

function slashHit(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const along = dx * 0.7071 + dy * 0.7071;
  const across = -dx * 0.7071 + dy * 0.7071;
  return Math.abs(across) < 0.075 && Math.abs(along) < 0.25;
}

function renderIcon(size, options) {
  const bg = hex(options.background);
  const fg = hex(options.foreground);
  const accent = hex(options.accent);
  const scale = 4;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let shieldHits = 0;
      let accentHits = 0;
      let total = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const nx = (x + (sx + 0.5) / scale) / size;
          const ny = (y + (sy + 0.5) / scale) / size;
          total++;
          if (options.tile && insideRoundedRect(nx * size, ny * size, size, size * 0.22)) bgHits++;
          if (insidePolygon(nx, ny, shield)) {
            if (slashHit(nx, ny)) accentHits++;
            else shieldHits++;
          }
        }
      }
      const offset = (y * size + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (bgHits > 0) {
        r = bg[0];
        g = bg[1];
        b = bg[2];
        a = Math.round(255 * (bgHits / total));
      }
      if (shieldHits > 0 || accentHits > 0) {
        const sr = shieldHits > 0 ? fg : accent;
        const color = shieldHits > 0 ? fg : accent;
        const coverage = (shieldHits + accentHits) / total;
        r = color[0];
        g = color[1];
        b = color[2];
        a = Math.round(255 * coverage);
        if (shieldHits > 0 && accentHits > 0) {
          const ratio = shieldHits / (shieldHits + accentHits);
          r = Math.round(sr[0] * ratio + accent[0] * (1 - ratio));
          g = Math.round(sr[1] * ratio + accent[1] * (1 - ratio));
          b = Math.round(sr[2] * ratio + accent[2] * (1 - ratio));
        }
        if (options.tile) {
          const insideTile = insideRoundedRect(x + 0.5, y + 0.5, size, size * 0.22);
          if (!insideTile) {
            a = 0;
          }
        }
      }
      buffer[offset] = r;
      buffer[offset + 1] = g;
      buffer[offset + 2] = b;
      buffer[offset + 3] = a;
    }
  }
  return encodePng(size, size, buffer);
}

function makeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const icon = renderIcon(256, {
  tile: true,
  background: '#10141A',
  foreground: '#F4F6F8',
  accent: '#FF6B3D',
});
fs.writeFileSync(path.join(assets, 'icon.png'), icon);
fs.writeFileSync(path.join(assets, 'icon.ico'), makeIco(icon));

const tray32 = renderIcon(32, {
  tile: false,
  background: '#000000',
  foreground: '#F4F6F8',
  accent: '#FF6B3D',
});
fs.writeFileSync(path.join(assets, 'tray-32.png'), tray32);
console.log('assets written');
