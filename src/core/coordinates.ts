import type { Pt, Rotation, Side } from "./types";
import { TILE_SIZE } from "./types";

/** Board delta for each side (y grows towards the south). */
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

/** The eight neighbours (monasteries count diagonals). */
export const NEIGHBOURS8: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];

/** Injective key for signed integer coordinates within +-32767. */
export function cellKey(x: number, y: number): number {
  return (x + 32768) * 65536 + (y + 32768);
}
export function keyX(k: number): number {
  return Math.floor(k / 65536) - 32768;
}
export function keyY(k: number): number {
  return (k % 65536) - 32768;
}

export function opposite(s: Side): Side {
  return ((s + 2) & 3) as Side;
}
export function rotateSide(s: Side, r: number): Side {
  return ((s + r) & 3) as Side;
}
/** Field port p (0..7) after r clockwise quarter turns. */
export function rotatePort(p: number, r: number): number {
  return (p + 2 * r) & 7;
}
/** Port facing port p across a shared edge: E0 <-> W1, E1 <-> W0... */
export function matchingPort(p: number): number {
  const side = p >> 1;
  return (((side + 2) & 3) << 1) | (1 - (p & 1));
}
export function portSide(p: number): Side {
  return (p >> 1) as Side;
}

/** Rotate a point of the tile square by r clockwise quarter turns around its centre. */
export function rotatePoint(p: Pt, r: number, size = TILE_SIZE): Pt {
  switch (r & 3) {
    case 1: return { x: size - p.y, y: p.x };
    case 2: return { x: size - p.x, y: size - p.y };
    case 3: return { x: p.y, y: size - p.x };
    default: return { x: p.x, y: p.y };
  }
}
export function unrotatePoint(p: Pt, r: number, size = TILE_SIZE): Pt {
  return rotatePoint(p, (4 - (r & 3)) & 3, size);
}

/** Tile corners clockwise: NW, NE, SE, SW. Side s runs from corner s to corner s+1. */
export const CORNERS: readonly Pt[] = [
  { x: 0, y: 0 }, { x: TILE_SIZE, y: 0 }, { x: TILE_SIZE, y: TILE_SIZE }, { x: 0, y: TILE_SIZE },
];
/** Inward unit normal of each side. */
export const INWARD: readonly Pt[] = [
  { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 },
];
/** Point at clockwise parameter t (0..128) along side s. */
export function sidePoint(s: Side, t: number): Pt {
  const a = CORNERS[s], b = CORNERS[(s + 1) & 3];
  const u = t / TILE_SIZE;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}
export type { Rotation };
