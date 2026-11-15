/** Deterministic value noise and light fBm (integer hashing, no tables, no assets). */
import { hash2 } from "../../core/hash";

const INV = 1 / 4294967296;

export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed) * INV, b = hash2(xi + 1, yi, seed) * INV;
  const c = hash2(xi, yi + 1, seed) * INV, d = hash2(xi + 1, yi + 1, seed) * INV;
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, seed: number, octaves = 3): number {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x, y, seed + o * 1013);
    norm += amp;
    x *= 2.03; y *= 2.03; amp *= 0.5;
  }
  return sum / norm;
}
