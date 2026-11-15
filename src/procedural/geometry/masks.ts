/**
 * Logical raster masks. Each pixel stores a terrain kind and a region id — never a colour.
 * Pixel (i, j) samples the nominal point ((i + 0.5) / scale, (j + 0.5) / scale).
 * Connectivity convention everywhere: FOUR neighbours (a diagonal contact never connects).
 */
import type { Pt } from "../../core/types";
import { ROAD_WIDTH, TILE_SIZE } from "../../core/types";

export const K_FIELD = 0, K_ROAD = 1, K_CITY = 2, K_TERMINAL = 3, K_MONASTERY = 4;
export const UNLABELED = 255;

export interface TileMask {
  res: number;
  kind: Uint8Array;
  id: Uint8Array;
}

export interface CityShape { id: number; outline: Pt[]; walls: Pt[][] }
export interface RoadShape { id: number; path: Pt[] }
export interface TerminalShape { id: number; kind: string; x: number; y: number; r: number }
export interface GateShape { x: number; y: number; nx: number; ny: number; cityId: number }
export interface TileShapes {
  cities: CityShape[];
  roads: RoadShape[];
  /** Only junction/village terminals own a disc. */
  terminals: TerminalShape[];
  monastery: { x: number; y: number; r: number } | null;
  gates: GateShape[];
}

export function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - a.x - t * dx, ey = py - a.y - t * dy;
  return Math.sqrt(ex * ex + ey * ey);
}
export function distToPolyline(px: number, py: number, pts: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = distToSegment(px, py, pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  return best;
}
export function pointInPolygon(px: number, py: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function rasterize(shapes: TileShapes, res = TILE_SIZE): TileMask {
  const n = res * res, scale = res / TILE_SIZE;
  const kind = new Uint8Array(n), id = new Uint8Array(n).fill(UNLABELED);
  const half = ROAD_WIDTH / 2;
  // 1. roads: thick polylines; the nearest centreline owns a pixel.
  const best = new Float32Array(n).fill(Infinity);
  for (const road of shapes.roads) {
    for (let s = 0; s + 1 < road.path.length; s++) {
      const a = road.path[s], b = road.path[s + 1];
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - half) * scale)), x1 = Math.min(res - 1, Math.ceil((Math.max(a.x, b.x) + half) * scale));
      const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - half) * scale)), y1 = Math.min(res - 1, Math.ceil((Math.max(a.y, b.y) + half) * scale));
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const d = distToSegment((i + 0.5) / scale, (j + 0.5) / scale, a, b);
        const k = j * res + i;
        if (d <= half && d < best[k]) { best[k] = d; kind[k] = K_ROAD; id[k] = road.id; }
      }
    }
  }
  // 2. discs: terminals then monastery.
  const disc = (cx: number, cy: number, r: number, kd: number, rid: number) => {
    const x0 = Math.max(0, Math.floor((cx - r) * scale)), x1 = Math.min(res - 1, Math.ceil((cx + r) * scale));
    const y0 = Math.max(0, Math.floor((cy - r) * scale)), y1 = Math.min(res - 1, Math.ceil((cy + r) * scale));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const dx = (i + 0.5) / scale - cx, dy = (j + 0.5) / scale - cy;
      if (dx * dx + dy * dy <= r * r) { const k = j * res + i; kind[k] = kd; id[k] = rid; }
    }
  };
  for (const t of shapes.terminals) disc(t.x, t.y, t.r, K_TERMINAL, t.id);
  if (shapes.monastery) disc(shapes.monastery.x, shapes.monastery.y, shapes.monastery.r, K_MONASTERY, 0);
  // 3. cities: even-odd scanline fill, highest priority.
  const xs: number[] = [];
  for (const c of shapes.cities) {
    const poly = c.outline;
    for (let j = 0; j < res; j++) {
      const y = (j + 0.5) / scale;
      xs.length = 0;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const p = poly[a], q = poly[b];
        if (p.y > y !== q.y > y) xs.push(((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x);
      }
      xs.sort((u, v) => u - v);
      for (let e = 0; e + 1 < xs.length; e += 2) {
        const i0 = Math.max(0, Math.ceil(xs[e] * scale - 0.5)), i1 = Math.min(res - 1, Math.ceil(xs[e + 1] * scale - 0.5) - 1);
        for (let i = i0; i <= i1; i++) { const k = j * res + i; kind[k] = K_CITY; id[k] = c.id; }
      }
    }
  }
  const mask: TileMask = { res, kind, id };
  despeckle(mask, 6 * scale * scale);
  return mask;
}

/**
 * Rasterisation rule: specks smaller than `minArea` pixels (cusps where a road band meets a
 * terminal disc, a wall or another road at a shallow angle) are not regions. Road specks
 * return to the field; field specks are absorbed by the neighbouring region.
 */
function despeckle(mask: TileMask, minArea: number): void {
  const { res, kind, id } = mask;
  const { label, comps } = components(mask);
  const drop = comps.map((c) => (c.kind === K_ROAD || c.kind === K_FIELD) && c.area < minArea);
  if (!drop.includes(true)) return;
  for (let pass = 0; pass < 6; pass++) {
    let left = 0;
    for (let k = 0; k < label.length; k++) {
      if (label[k] < 0 || !drop[label[k]]) continue;
      const i = k % res, j = (k - i) / res;
      const wantField = kind[k] === K_ROAD;
      let pick = -1;
      for (const q of [i > 0 ? k - 1 : -1, j > 0 ? k - res : -1, i < res - 1 ? k + 1 : -1, j < res - 1 ? k + res : -1]) {
        if (q < 0 || (label[q] >= 0 && drop[label[q]])) continue;
        if (pick < 0 || (wantField && kind[q] === K_FIELD && kind[pick] !== K_FIELD)) pick = q;
      }
      if (pick < 0) { left++; continue; }
      kind[k] = kind[pick]; id[k] = id[pick]; label[k] = -1;
    }
    if (!left) break;
  }
}

export interface Component { kind: number; id: number; area: number; touchesBorder: boolean }

/** 4-connected components of identical (kind, id). */
export function components(mask: TileMask): { label: Int32Array; comps: Component[] } {
  const { res, kind, id } = mask;
  const n = res * res;
  const label = new Int32Array(n).fill(-1);
  const comps: Component[] = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (label[start] >= 0) continue;
    const kd = kind[start], rid = id[start], c = comps.length;
    const comp: Component = { kind: kd, id: rid, area: 0, touchesBorder: false };
    let sp = 0;
    stack[sp++] = start;
    label[start] = c;
    while (sp > 0) {
      const k = stack[--sp];
      comp.area++;
      const i = k % res, j = (k - i) / res;
      if (i === 0 || j === 0 || i === res - 1 || j === res - 1) comp.touchesBorder = true;
      if (i > 0) { const q = k - 1; if (label[q] < 0 && kind[q] === kd && id[q] === rid) { label[q] = c; stack[sp++] = q; } }
      if (i < res - 1) { const q = k + 1; if (label[q] < 0 && kind[q] === kd && id[q] === rid) { label[q] = c; stack[sp++] = q; } }
      if (j > 0) { const q = k - res; if (label[q] < 0 && kind[q] === kd && id[q] === rid) { label[q] = c; stack[sp++] = q; } }
      if (j < res - 1) { const q = k + res; if (label[q] < 0 && kind[q] === kd && id[q] === rid) { label[q] = c; stack[sp++] = q; } }
    }
    comps.push(comp);
  }
  return { label, comps };
}

/** Chamfer distance (in pixels) to the nearest pixel of another region or to the tile border. */
export function distanceField(mask: TileMask): Float32Array {
  const { res, kind, id } = mask;
  const n = res * res;
  const d = new Float32Array(n).fill(1e6);
  const code = (k: number) => (kind[k] << 8) | id[k];
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const k = j * res + i, c = code(k);
    if (i === 0 || j === 0 || i === res - 1 || j === res - 1) d[k] = 1;
    else if (code(k - 1) !== c || code(k + 1) !== c || code(k - res) !== c || code(k + res) !== c) d[k] = 1;
  }
  const A = 1, B = 1.4142;
  for (let j = 1; j < res; j++) for (let i = 1; i < res - 1; i++) {
    const k = j * res + i;
    d[k] = Math.min(d[k], d[k - 1] + A, d[k - res] + A, d[k - res - 1] + B, d[k - res + 1] + B);
  }
  for (let j = res - 2; j >= 0; j--) for (let i = res - 2; i >= 1; i--) {
    const k = j * res + i;
    d[k] = Math.min(d[k], d[k + 1] + A, d[k + res] + A, d[k + res + 1] + B, d[k + res - 1] + B);
  }
  return d;
}
