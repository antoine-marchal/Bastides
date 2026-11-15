/**
 * Deterministic, versioned randomness.
 *
 * Generator: xoshiro128** (Blackman & Vigna, 2018), 128-bit state, 32-bit output,
 * implemented with explicit 32-bit integer operations only.
 * Seeding: the four state words are derived from a string key with four independently
 * seeded MurmurHash3 passes followed by SplitMix32 scrambling (never all-zero).
 *
 * Streams are identified by a *key path* ("game/deck", "game/bot:2/turn:14"...).
 * `fork(label)` derives a child stream from the key only, never from the number of
 * values already consumed: changing how many numbers one subsystem draws can never
 * shift the values seen by another subsystem.
 *
 * This is a PRNG: reproducible by design, not "true" randomness. Unpredictability
 * comes exclusively from the initial seed (crypto.getRandomValues).
 */
import { murmur3 } from "./hash";

export const RANDOM_VERSION = 1;

export interface RandomSource {
  nextUint32(): number;
  nextFloat(): number;
  nextInt(min: number, max: number): number;
  shuffle<T>(items: T[]): T[];
  weightedChoice<T>(items: readonly T[], weights: readonly number[]): T;
  fork(label: string): RandomSource;
}

function splitmix32(a: number): number {
  a = (a + 0x9e3779b9) | 0;
  let t = a ^ (a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}

export class Xoshiro128 implements RandomSource {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly key: string) {
    this.a = splitmix32(murmur3(key, 0x1f123bb5));
    this.b = splitmix32(murmur3(key, 0x9e3779b9));
    this.c = splitmix32(murmur3(key, 0x85ebca6b));
    this.d = splitmix32(murmur3(key, 0xc2b2ae35));
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 0x9e3779b9;
    for (let i = 0; i < 8; i++) this.nextUint32();
  }

  nextUint32(): number {
    const r = Math.imul(this.b, 5);
    const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;
    const t = this.b << 9;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = (this.d << 11) | (this.d >>> 21);
    return result;
  }

  /** Uniform in [0, 1) with 32 bits of resolution. */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive, without modulo bias (rejection sampling). */
  nextInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new Error("nextInt: invalid range");
    const range = max - min + 1;
    if (range > 4294967296) throw new Error("nextInt: range too large");
    if (range === 4294967296) return min + this.nextUint32();
    const limit = 4294967296 - (4294967296 % range);
    let v = this.nextUint32();
    while (v >= limit) v = this.nextUint32();
    return min + (v % range);
  }

  /** In-place Fisher-Yates (Durstenfeld); returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  weightedChoice<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0 || items.length !== weights.length) throw new Error("weightedChoice: bad input");
    let total = 0;
    for (const w of weights) {
      if (!(w >= 0) || !Number.isFinite(w)) throw new Error("weightedChoice: bad weight");
      total += w;
    }
    if (total <= 0) throw new Error("weightedChoice: zero total weight");
    let r = this.nextFloat() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    for (let i = items.length - 1; i >= 0; i--) if (weights[i] > 0) return items[i];
    return items[items.length - 1];
  }

  fork(label: string): RandomSource {
    return new Xoshiro128(this.key + "/" + label);
  }
}

export function createRandom(key: string): RandomSource {
  return new Xoshiro128("v" + RANDOM_VERSION + ":" + key);
}

/** Fresh unpredictable seed (hex, 128 bits) from the platform CSPRNG. */
export function randomSeedString(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The independent seed domains of a game. */
export const SeedDomain = {
  deck: "deck",
  topology: "topology",
  geometry: "geometry",
  visual: "visual",
  cosmetic: "cosmetic",
  bot: (playerIndex: number) => "bot:" + playerIndex,
} as const;
