/** Set partitions and non-crossing tests on points placed on a circle (the four sides). */

/** All set partitions of `items` (Bell number many). Blocks keep input order. */
export function setPartitions<T>(items: readonly T[]): T[][][] {
  if (items.length === 0) return [[]];
  const [first, ...rest] = items;
  const out: T[][][] = [];
  for (const p of setPartitions(rest)) {
    out.push([[first], ...p]);
    for (let i = 0; i < p.length; i++) {
      out.push(p.map((b, j) => (j === i ? [first, ...b] : b)));
    }
  }
  return out;
}

/** True when blocks A and B (positions on a circle) interleave: a < b < a' < b' cyclically. */
export function blocksCross(a: readonly number[], b: readonly number[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const lo = Math.min(a[i], a[j]), hi = Math.max(a[i], a[j]);
      let inside = false, outside = false;
      for (const x of b) {
        if (x > lo && x < hi) inside = true;
        else if (x < lo || x > hi) outside = true;
      }
      if (inside && outside) return true;
    }
  }
  return false;
}

/** A family of disjoint blocks is planar iff no two blocks cross. */
export function isNonCrossing(blocks: readonly (readonly number[])[]): boolean {
  for (let i = 0; i < blocks.length; i++)
    for (let j = i + 1; j < blocks.length; j++) if (blocksCross(blocks[i], blocks[j])) return false;
  return true;
}

/** Partitions of items into blocks of size 1 or 2 (partial matchings). */
export function matchings<T>(items: readonly T[]): { pairs: [T, T][]; singles: T[] }[] {
  if (items.length === 0) return [{ pairs: [], singles: [] }];
  const [first, ...rest] = items;
  const out: { pairs: [T, T][]; singles: T[] }[] = [];
  for (const m of matchings(rest)) out.push({ pairs: m.pairs, singles: [first, ...m.singles] });
  for (let i = 0; i < rest.length; i++) {
    const others = rest.filter((_, j) => j !== i);
    for (const m of matchings(others)) out.push({ pairs: [[first, rest[i]], ...m.pairs], singles: m.singles });
  }
  return out;
}
