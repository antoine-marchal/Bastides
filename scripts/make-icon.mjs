// Generates the application icon mathematically (ICO with BMP entries, no PNG, no asset in the repo).
import { mkdirSync, writeFileSync } from "node:fs";

function pixel(u, v) {
  // u, v in [0,1]. A tiny landscape: meadow, a curved road, a walled town with a red roof.
  const inR = (cx, cy, r) => (u - cx) ** 2 + (v - cy) ** 2 < r * r;
  const corner = 0.16, dx = Math.max(corner - u, u - (1 - corner), 0), dy = Math.max(corner - v, v - (1 - corner), 0);
  if (dx * dx + dy * dy > corner * corner) return [0, 0, 0, 0];
  let c = [122 + 30 * Math.sin(u * 9) * Math.sin(v * 7), 170, 78];
  const road = Math.abs(v - (0.72 - 0.18 * Math.sin(u * 3.1))) < 0.07;
  if (road) c = [214, 190, 144];
  const d = Math.hypot(u - 0.5, v + 0.08);
  if (d < 0.5) c = [208, 190, 152];
  if (d > 0.47 && d < 0.53) c = [150, 144, 130];
  if (inR(0.5, 0.2, 0.13)) c = [176, 82, 58];
  if (inR(0.47, 0.17, 0.06)) c = [210, 122, 88];
  if (inR(0.2, 0.52, 0.07) || inR(0.8, 0.5, 0.06)) c = [84, 128, 60];
  if (inR(0.21, 0.37, 0.06) || inR(0.79, 0.36, 0.06)) c = [120, 114, 104];
  return [c[0], c[1], c[2], 255];
}

function dib(size) {
  const rowMask = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + rowMask * size);
  buf.writeUInt32LE(40, 0); buf.writeInt32LE(size, 4); buf.writeInt32LE(size * 2, 8);
  buf.writeUInt16LE(1, 12); buf.writeUInt16LE(32, 14); buf.writeUInt32LE(size * size * 4, 20);
  const ss = 3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const p = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
      r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
    }
    const o = 40 + ((size - 1 - y) * size + x) * 4;
    if (a > 0) { buf[o] = Math.round(b / a); buf[o + 1] = Math.round(g / a); buf[o + 2] = Math.round(r / a); }
    buf[o + 3] = Math.round(a / (ss * ss));
  }
  return buf;
}

const sizes = [16, 32, 48, 64];
const images = sizes.map(dib);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header[e] = s % 256; header[e + 1] = s % 256;
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
mkdirSync(new URL("../src-tauri/icons/", import.meta.url), { recursive: true });
writeFileSync(new URL("../src-tauri/icons/icon.ico", import.meta.url), Buffer.concat([header, ...images]));
console.log("icon.ico generated (" + offset + " bytes)");

// `--png`: also write a 1024 px PNG master, from which `tauri icon` derives the
// Android launcher icons (mipmaps). Generated, not versioned, like the .ico.
if (process.argv.includes("--png")) {
  const { deflateSync } = await import("node:zlib");
  const size = 1024, ss = 2;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const p = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (a > 0) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); }
      raw[o + 3] = Math.round(a / (ss * ss));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(new URL("../src-tauri/icons/source.png", import.meta.url), png);
  console.log("source.png generated (" + png.length + " bytes)");
}
