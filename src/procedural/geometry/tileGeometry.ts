/**
 * Planar geometry of a tile, materialising its topology.
 *
 * Pipeline: reserve edge profiles -> city envelopes (walls are curves joining tile corners)
 * -> monastery -> road skeletons (smooth splines through clearance-checked waypoints)
 * -> terminals -> raster mask -> independent validation -> field labelling -> anchors.
 *
 * Geometry is always produced in the CANONICAL orientation of the topology and rotated
 * afterwards, so a tile keeps its shape when the player turns it.
 * A geometry that does not reproduce the requested topology is never returned: the
 * generator retries with other sub-seeds, then falls back to a calm deterministic layout,
 * then throws GeometryError.
 */
import { Terrain, TILE_SIZE } from "../../core/types";
import type { Pt, Side, TileTopology } from "../../core/types";
import { CORNERS, INWARD, rotatePoint, sidePoint, unrotatePoint } from "../../core/coordinates";
import { createRandom } from "../../core/random";
import type { RandomSource } from "../../core/random";
import { deriveSeed } from "../../core/hash";
import { getTopology } from "../topology/catalog";
import { K_CITY, K_FIELD, K_MONASTERY, K_ROAD, distToPolyline, distanceField, pointInPolygon, rasterize } from "./masks";
import type { CityShape, GateShape, RoadShape, TerminalShape, TileMask, TileShapes } from "./masks";
import { validateMask } from "./validator";

export const CORNER_RETREAT = 6;
export const MAX_ATTEMPTS = 6;
const S = TILE_SIZE, C = S / 2;

export class GeometryError extends Error {}

export interface TileGeometry {
  topologyId: string;
  seed: number;
  shapes: TileShapes;
  /** 128x128 logical mask in canonical orientation; field pixels carry declared field ids. */
  mask: TileMask;
  /** Meeple anchor of every feature (cities, roads, fields, monastery), canonical orientation. */
  anchors: Pt[];
  /** 0..MAX_ATTEMPTS-1 = seeded attempt, MAX_ATTEMPTS = calm fallback. */
  attempt: number;
}

const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const mix = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (p: Pt): Pt => { const l = Math.hypot(p.x, p.y) || 1; return { x: p.x / l, y: p.y / l }; };

function quad(p0: Pt, c: Pt, p1: Pt, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y });
  }
  return out;
}

/**
 * Hermite/Catmull-Rom spline through waypoints with imposed end tangents.
 * Roads use it between their "lead" points; the first 10 px from an edge are a straight
 * segment perpendicular to that edge (the constrained junction band).
 */
export function spline(pts: Pt[], startDir: Pt, endDir?: Pt, steps = 8): Pt[] {
  const out: Pt[] = [pts[0]];
  const n = pts.length;
  const tangent = (i: number): Pt => {
    if (i === 0) { const l = dist(pts[0], pts[1]) * 0.6; return { x: startDir.x * l, y: startDir.y * l }; }
    if (i === n - 1) {
      if (endDir) { const l = dist(pts[i], pts[i - 1]) * 0.6; return { x: endDir.x * l, y: endDir.y * l }; }
      return { x: (pts[i].x - pts[i - 1].x) * 0.5, y: (pts[i].y - pts[i - 1].y) * 0.5 };
    }
    return { x: (pts[i + 1].x - pts[i - 1].x) * 0.5, y: (pts[i + 1].y - pts[i - 1].y) * 0.5 };
  };
  for (let i = 0; i + 1 < n; i++) {
    const p0 = pts[i], p1 = pts[i + 1], m0 = tangent(i), m1 = tangent(i + 1);
    const k = Math.max(3, Math.ceil((dist(p0, p1) / 40) * steps));
    for (let s = 1; s <= k; s++) {
      const t = s / k, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push({ x: h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x, y: h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y });
    }
  }
  return out;
}

function buildShapes(t: TileTopology, rng: RandomSource, calm: boolean): TileShapes {
  const R = (min: number, max: number, safe: number) => (calm ? safe : min + rng.nextFloat() * (max - min));
  const cityOfSide = [-1, -1, -1, -1];
  for (const c of t.cities) for (const s of c.sides) cityOfSide[s] = c.id;
  const E = t.edges;
  const center: Pt = { x: C, y: C };

  // ---- cities -------------------------------------------------------------------------
  const cities: CityShape[] = [];
  for (const c of t.cities) {
    const member = (s: number) => cityOfSide[s & 3] === c.id;
    if (c.sides.length === 4) { cities.push({ id: c.id, outline: CORNERS.map((p) => ({ ...p })), walls: [] }); continue; }
    const startPt = (s: number): Pt => (E[(s + 3) & 3] === Terrain.CITY && !member(s + 3) ? sidePoint((s & 3) as Side, CORNER_RETREAT) : CORNERS[s & 3]);
    const endPt = (s: number): Pt => (E[(s + 1) & 3] === Terrain.CITY && !member(s + 1) ? sidePoint((s & 3) as Side, S - CORNER_RETREAT) : CORNERS[(s + 1) & 3]);
    const outline: Pt[] = [], walls: Pt[][] = [];
    let start = 0;
    while (!(member(start) && !member(start + 3))) start++;
    let s = start;
    do {
      outline.push(startPt(s));
      while (member(s + 1)) { outline.push(CORNERS[(s + 1) & 3]); s++; }
      const pEnd = endPt(s);
      outline.push(pEnd);
      const g0 = s + 1;
      let gapLen = 0;
      while (!member(g0 + gapLen)) gapLen++;
      const next = g0 + gapLen;
      const q = startPt(next);
      const chord = unit({ x: q.x - pEnd.x, y: q.y - pEnd.y });
      const mid = mix(pEnd, q, 0.5);
      let ctrl: Pt;
      if (gapLen === 2) {
        const free = CORNERS[(g0 + 1) & 3];
        const dir = unit({ x: C - free.x, y: C - free.y });
        const busy = E[g0 & 3] !== Terrain.GRASS || E[(g0 + 1) & 3] !== Terrain.GRASS;
        const delta = busy ? R(5, 22, 12) : R(-8, 24, 10);
        ctrl = add(add(center, dir, 2 * delta), chord, R(-8, 8, 0));
      } else {
        let depth: number;
        let n: Pt;
        if (gapLen === 1) {
          const g = E[g0 & 3];
          n = INWARD[g0 & 3];
          depth = g === Terrain.CITY ? R(30, 36, 33) : g === Terrain.ROAD ? R(22, 30, 26) : R(16, 28, 22);
        } else {
          const m = s & 3;
          n = INWARD[m];
          const l = cityOfSide[(m + 3) & 3], r = cityOfSide[(m + 1) & 3];
          if (l >= 0 && l === r) depth = R(12, 16, 14);
          else if (t.monastery) depth = R(18, 24, 20);
          else if (t.cities.length > 1) depth = R(18, 27, 22);
          else depth = R(20, 32, 26);
        }
        ctrl = add(add(mid, n, 2 * depth), chord, R(-12, 12, 0));
      }
      const wall = quad(pEnd, ctrl, q, 28);
      // Organic wobble along the normal, vanishing at both ends.
      const amp = R(0, 2.2, 0), f1 = R(1, 2.5, 1), f2 = R(3, 5, 3), ph1 = R(0, 6.28, 0), ph2 = R(0, 6.28, 0);
      for (let i = 1; i < wall.length - 1; i++) {
        const u = i / (wall.length - 1);
        const tx = wall[i + 1].x - wall[i - 1].x, ty = wall[i + 1].y - wall[i - 1].y;
        const l = Math.hypot(tx, ty) || 1;
        const w = amp * Math.sin(Math.PI * u) * (0.6 * Math.sin(6.283 * f1 * u + ph1) + 0.4 * Math.sin(6.283 * f2 * u + ph2));
        wall[i] = { x: wall[i].x - (ty / l) * w, y: wall[i].y + (tx / l) * w };
      }
      walls.push(wall);
      for (let i = 1; i < wall.length - 1; i++) outline.push(wall[i]);
      s = next;
    } while ((s & 3) !== (start & 3));
    cities.push({ id: c.id, outline, walls });
  }
  const cityDist = (p: Pt, only = -1): number => {
    let best = Infinity;
    for (const c of cities) {
      if (only >= 0 && c.id !== only) continue;
      if (pointInPolygon(p.x, p.y, c.outline)) return 0;
      for (const w of c.walls) best = Math.min(best, distToPolyline(p.x, p.y, w));
    }
    return best;
  };
  const borderDist = (p: Pt) => Math.min(p.x, p.y, S - p.x, S - p.y);

  const roads: RoadShape[] = [];
  const roadDist = (p: Pt) => { let b = Infinity; for (const r of roads) b = Math.min(b, distToPolyline(p.x, p.y, r.path)); return b; };

  /** Best candidate near `pref`: valid when clearance(p) >= 0; deterministic tie-break by seed. */
  const pickSpot = (pref: Pt, radius: number, clearance: (p: Pt) => number): Pt => {
    let best = pref, bestScore = -Infinity, bestValid = false;
    for (let dy = -radius; dy <= radius; dy += 3) for (let dx = -radius; dx <= radius; dx += 3) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const p = { x: pref.x + dx, y: pref.y + dy };
      const cl = clearance(p);
      const valid = cl >= 0;
      const score = valid ? Math.min(cl, 10) * 0.3 - Math.hypot(dx, dy) * 0.5 + R(0, 6, 0) : cl;
      if ((valid && !bestValid) || (valid === bestValid && score > bestScore)) { best = p; bestScore = score; bestValid = valid; }
    }
    return best;
  };

  // ---- monastery ----------------------------------------------------------------------
  let monastery: TileShapes["monastery"] = null;
  if (t.monastery) {
    let pref = add(center, { x: R(-5, 5, 0), y: R(-5, 5, 0) });
    for (const c of t.cities) pref = add(pref, INWARD[c.sides[0]], 10);
    const p = pickSpot(pref, 12, (q) => Math.min(cityDist(q) - 21, borderDist(q) - 30));
    monastery = { x: p.x, y: p.y, r: 14 };
  }

  // ---- roads --------------------------------------------------------------------------
  const sideMid = (s: Side) => sidePoint(s, C);
  const lead = (s: Side) => add(sideMid(s), INWARD[s], 10);
  const terminals: TerminalShape[] = [];
  const gates: GateShape[] = [];
  const through = t.roads.filter((r) => r.sides.length === 2);
  const stubs = t.roads.filter((r) => r.sides.length === 1);

  for (const r of through) {
    const [a, b] = r.sides;
    const pa = sideMid(a), pb = sideMid(b);
    const cands: Pt[] = [];
    if (((a + 2) & 3) === b) {
      const perp = { x: Math.abs(INWARD[a].y), y: Math.abs(INWARD[a].x) };
      const along = R(-8, 8, 0);
      for (let o = -14; o <= 14; o += 2) cands.push(add(add(center, perp, o), INWARD[a], along));
    } else {
      const corner = ((a + 1) & 3) === b ? CORNERS[b] : CORNERS[a];
      const dir = unit({ x: corner.x - C, y: corner.y - C });
      for (let o = -4; o <= 26; o += 2) cands.push(add(center, dir, o));
    }
    const clear = (p: Pt) => Math.min(cityDist(p) - 16, roadDist(p) - 24);
    const valid = cands.filter((p) => clear(p) >= 0);
    let m: Pt;
    if (valid.length) m = calm ? valid[valid.length >> 1] : valid[rng.nextInt(0, valid.length - 1)];
    else m = cands.reduce((x, y) => (clear(y) > clear(x) ? y : x));
    roads.push({ id: r.id, path: [pa, ...spline([lead(a), m, lead(b)], INWARD[a], { x: -INWARD[b].x, y: -INWARD[b].y }), pb] });
  }

  if (stubs.length) {
    const term = t.terminals[0];
    if (term.kind === "junction") {
      let mean = { x: 0, y: 0 };
      for (const r of stubs) mean = add(mean, sideMid(r.sides[0]), 1 / stubs.length);
      const pref = add(mix(center, mean, 0.5), { x: R(-6, 6, 0), y: R(-6, 6, 0) });
      const j = pickSpot(pref, 15, (q) => Math.min(cityDist(q) - 18, borderDist(q) - 28));
      terminals.push({ id: term.id, kind: term.kind, x: j.x, y: j.y, r: 11 });
      for (const r of stubs) roads.push({ id: r.id, path: [sideMid(r.sides[0]), ...spline([lead(r.sides[0]), j], INWARD[r.sides[0]])] });
    } else {
      const r = stubs[0], side = r.sides[0], p0 = sideMid(side), n = INWARD[side];
      const lateral = { x: -n.y, y: n.x };
      if (term.kind === "village") {
        const pref = add(add(p0, n, R(40, 58, 48)), lateral, R(-10, 10, 0));
        const v = pickSpot(pref, 12, (q) => Math.min(cityDist(q) - 17, borderDist(q) - 26));
        terminals.push({ id: term.id, kind: term.kind, x: v.x, y: v.y, r: 10 });
        roads.push({ id: r.id, path: [p0, ...spline([lead(side), v], n)] });
      } else if (term.kind === "monastery" && monastery) {
        roads.push({ id: r.id, path: [p0, ...spline([lead(side), { x: monastery.x, y: monastery.y }], n)] });
      } else {
        // City gate: nearest suitable point of the gate city's walls.
        const city = cities.find((c) => c.id === term.cityId)!;
        const aim = mix(center, p0, 0.5 + R(-0.12, 0.12, 0));
        let best: Pt | null = null, bestN: Pt = n, bestD = Infinity;
        for (const w of city.walls) for (let i = 2; i < w.length - 2; i++) {
          const q = w[i];
          if (borderDist(q) < 14) continue;
          const d = dist(q, aim);
          if (d < bestD) {
            const tx = w[i + 1].x - w[i - 1].x, ty = w[i + 1].y - w[i - 1].y, l = Math.hypot(tx, ty) || 1;
            let nn = { x: -ty / l, y: tx / l };
            if (pointInPolygon(q.x + nn.x * 3, q.y + nn.y * 3, city.outline)) nn = { x: -nn.x, y: -nn.y };
            best = q; bestN = nn; bestD = d;
          }
        }
        if (!best) throw new GeometryError("no wall available for the gate");
        const inside = add(best, bestN, -5), pre = add(best, bestN, 12);
        const way = [lead(side)];
        if (dist(pre, way[0]) > 9) way.push(pre);
        way.push(inside);
        roads.push({ id: r.id, path: [p0, ...spline(way, n, { x: -bestN.x, y: -bestN.y })] });
        gates.push({ x: best.x, y: best.y, nx: bestN.x, ny: bestN.y, cityId: city.id });
      }
    }
  }
  roads.sort((a, b) => a.id - b.id);
  return { cities, roads, terminals, monastery, gates };
}

/** Feature index layout shared by the whole project: cities, roads, fields, monastery. */
export function featureIndex(t: TileTopology, kind: "city" | "road" | "field" | "monastery", id = 0): number {
  if (kind === "city") return id;
  if (kind === "road") return t.cities.length + id;
  if (kind === "field") return t.cities.length + t.roads.length + id;
  return t.cities.length + t.roads.length + t.fields.length;
}

function finalize(t: TileTopology, seed: number, shapes: TileShapes, mask: TileMask, attempt: number): TileGeometry {
  const { res, kind, id } = mask;
  const df = distanceField(mask);
  const nf = t.cities.length + t.roads.length + t.fields.length + (t.monastery ? 1 : 0);
  const anchors: Pt[] = new Array(nf);
  const best = new Float32Array(nf).fill(-1);
  for (let k = 0; k < res * res; k++) {
    const kd = kind[k];
    let f = -1;
    if (kd === K_CITY) f = featureIndex(t, "city", id[k]);
    else if (kd === K_FIELD) f = featureIndex(t, "field", id[k]);
    if (f < 0) continue;
    // Prefer deep pixels; break ties towards the tile centre for stability.
    const i = k % res, j = (k - i) / res;
    const score = Math.min(df[k], 14) - 0.01 * Math.hypot(i - res / 2, j - res / 2);
    if (score > best[f]) { best[f] = score; anchors[f] = { x: i + 0.5, y: j + 0.5 }; }
  }
  for (const r of shapes.roads) {
    const topo = t.roads.find((x) => x.id === r.id)!;
    const at = topo.sides.length === 2 ? 0.5 : 0.42;
    anchors[featureIndex(t, "road", r.id)] = r.path[Math.floor((r.path.length - 1) * at)];
  }
  if (shapes.monastery) anchors[nf - 1] = { x: shapes.monastery.x, y: shapes.monastery.y };
  for (let f = 0; f < nf; f++) if (!anchors[f]) throw new GeometryError("feature without anchor");
  return { topologyId: t.id, seed, shapes, mask, anchors, attempt };
}

/** One attempt: build shapes, rasterise, validate. Returns errors instead of throwing. */
export function tryGeometry(t: TileTopology, seed: number, attempt: number): { geometry?: TileGeometry; errors: string[] } {
  const calm = attempt >= MAX_ATTEMPTS;
  const rng = createRandom("geo:" + t.id + ":" + (seed >>> 0) + ":" + attempt);
  let shapes: TileShapes;
  try { shapes = buildShapes(t, rng, calm); } catch (e) { return { errors: [(e as Error).message] }; }
  const mask = rasterize(shapes, TILE_SIZE);
  const v = validateMask(t, mask);
  if (!v.ok) return { errors: v.errors };
  // Label field pixels with the declared field ids.
  const map = new Map<number, number>();
  v.fieldComps.forEach((ci, fi) => map.set(ci, v.fieldIds[fi]));
  for (let k = 0; k < mask.kind.length; k++) if (mask.kind[k] === K_FIELD) mask.id[k] = map.get(v.label[k])!;
  return { geometry: finalize(t, seed, shapes, mask, attempt), errors: [] };
}

const geometryCache = new Map<string, TileGeometry>();
const CACHE_MAX = 512;

/** Deterministic geometry of (canonical topology id, geometry seed). Throws GeometryError. */
export function generateGeometry(topologyId: string, geometrySeed: number): TileGeometry {
  const key = topologyId + "#" + (geometrySeed >>> 0);
  const hit = geometryCache.get(key);
  if (hit) { geometryCache.delete(key); geometryCache.set(key, hit); return hit; }
  const t = getTopology(topologyId);
  let last: string[] = [];
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = tryGeometry(t, geometrySeed, attempt);
    if (r.geometry) {
      geometryCache.set(key, r.geometry);
      if (geometryCache.size > CACHE_MAX) geometryCache.delete(geometryCache.keys().next().value!);
      return r.geometry;
    }
    last = r.errors;
  }
  throw new GeometryError(`No valid geometry for ${topologyId} (seed ${geometrySeed}): ${last.join("; ")}`);
}

export function geometrySeedOf(tileSeed: number): number { return deriveSeed(tileSeed, "geometry"); }
export function visualSeedOf(tileSeed: number): number { return deriveSeed(tileSeed, "visual"); }
export function topologySeedOf(tileSeed: number): number { return deriveSeed(tileSeed, "topology"); }

/** Feature index under a point given in ROTATED tile coordinates, or -1 (terminal discs). */
export function featureAt(g: TileGeometry, rotation: number, x: number, y: number): number {
  const p = unrotatePoint({ x, y }, rotation);
  const i = Math.floor(p.x), j = Math.floor(p.y);
  if (i < 0 || j < 0 || i >= TILE_SIZE || j >= TILE_SIZE) return -1;
  const t = getTopology(g.topologyId);
  const k = j * TILE_SIZE + i, kd = g.mask.kind[k];
  if (kd === K_CITY) return featureIndex(t, "city", g.mask.id[k]);
  if (kd === K_ROAD) return featureIndex(t, "road", g.mask.id[k]);
  if (kd === K_FIELD) return featureIndex(t, "field", g.mask.id[k]);
  if (kd === K_MONASTERY) return featureIndex(t, "monastery");
  return -1;
}

export function rotatedAnchor(g: TileGeometry, rotation: number, feature: number): Pt {
  return rotatePoint(g.anchors[feature], rotation);
}
