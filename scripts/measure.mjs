// Measures what is actually shipped: frontend (raw / gzip / brotli), executable, installers.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const kb = (n) => (n / 1024).toFixed(1).padStart(9) + " Ko";

let raw = 0, gz = 0, br = 0;
console.log("Frontend (dist/)");
for (const f of walk(join(root, "dist"))) {
  const buf = readFileSync(f);
  const g = gzipSync(buf, { level: 9 }).length, b = brotliCompressSync(buf).length;
  raw += buf.length; gz += g; br += b;
  console.log(`  ${f.slice(root.length).padEnd(38)} ${kb(buf.length)}  gzip ${kb(g)}  brotli ${kb(b)}`);
}
console.log(`  ${"TOTAL".padEnd(38)} ${kb(raw)}  gzip ${kb(gz)}  brotli ${kb(br)}`);
const images = walk(join(root, "dist")).filter((f) => /\.(png|jpe?g|webp|gif|svg|avif|woff2?|ttf|mp4|ogg|mp3|wav)$/i.test(f));
console.log(`  images, fonts, audio or video files shipped: ${images.length}`);

console.log("\nNative (src-tauri/target/release)");
const rel = join(root, "src-tauri", "target", "release");
for (const name of ["bastides.exe", "bastides"]) if (existsSync(join(rel, name))) console.log(`  ${name.padEnd(38)} ${kb(statSync(join(rel, name)).size)}`);
for (const f of walk(join(rel, "bundle"))) if (/\.(exe|msi|dmg|deb|rpm|AppImage)$/.test(f)) console.log(`  ${f.slice(rel.length + 1).padEnd(38)} ${kb(statSync(f).size)}`);
