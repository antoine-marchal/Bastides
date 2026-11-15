/**
 * Decoration layout (pure data, no Canvas): houses, towers, trees, crops, shields...
 * Decorations are placed INSIDE existing logical regions read from the mask; they never
 * change a mask, an interface or a rule. They use the visual seed only.
 */
import { TILE_SIZE } from "../../core/types";
import type { Pt } from "../../core/types";
import { rotatePoint } from "../../core/coordinates";
import { createRandom } from "../../core/random";
import { getTopology } from "../topology/catalog";
import { K_CITY, K_FIELD, distanceField } from "../geometry/masks";
import { featureIndex } from "../geometry/tileGeometry";
import type { TileGeometry } from "../geometry/tileGeometry";
import { fbm } from "./noise";

export interface House { x: number; y: number; w: number; h: number; a: number; roof: number; seed: number }
export interface Tree { x: number; y: number; r: number; conifer: boolean; tone: number }
export interface Decor {
  houses: House[];
  towers: { x: number; y: number; r: number }[];
  trees: Tree[];
  bushes: { x: number; y: number; r: number }[];
  flowers: { x: number; y: number; c: number }[];
  rocks: { x: number; y: number; r: number }[];
  crops: { x: number; y: number; w: number; h: number; a: number; c: number }[];
  shields: { x: number; y: number; seed: number }[];
  keeps: { x: number; y: number; r: number }[];
}

const FOREST_SEED = 0x51f15e;

/** Layout in WORLD orientation for a tile placed at (tx, ty) with the given rotation. */
export function generateDecor(g: TileGeometry, visualSeed: number, rotation: number, tx: number, ty: number): Decor {
  const t = getTopology(g.topologyId);
  const rng = createRandom("decor:" + g.topologyId + ":" + (visualSeed >>> 0));
  const { kind, id } = g.mask;
  const df = distanceField(g.mask);
  const S = TILE_SIZE;
  const at = (x: number, y: number) => { const i = Math.floor(x), j = Math.floor(y); return i < 0 || j < 0 || i >= S || j >= S ? -1 : j * S + i; };
  const R = (a: number, b: number) => a + rng.nextFloat() * (b - a);
  const d: Decor = { houses: [], towers: [], trees: [], bushes: [], flowers: [], rocks: [], crops: [], shields: [], keeps: [] };
  const world = (p: Pt): Pt => { const q = rotatePoint(p, rotation); return { x: tx * S + q.x, y: ty * S + q.y }; };

  // ---- cities: shield, optional keep, houses on a jittered relaxation of random candidates.
  const blocked: { x: number; y: number; r: number }[] = g.shapes.gates.map((gt) => ({ x: gt.x - gt.nx * 6, y: gt.y - gt.ny * 6, r: 9 }));
  for (const c of t.cities) {
    const anchor = g.anchors[featureIndex(t, "city", c.id)];
    if (c.shields > 0) { d.shields.push({ x: anchor.x, y: anchor.y, seed: rng.nextUint32() }); blocked.push({ x: anchor.x, y: anchor.y, r: 10 }); }
    else if (c.sides.length >= 3 && rng.nextFloat() < 0.6) { d.keeps.push({ x: anchor.x, y: anchor.y, r: 7.5 }); blocked.push({ x: anchor.x, y: anchor.y, r: 12 }); }
    const base = R(0, Math.PI / 2);
    const placed: House[] = [];
    for (let k = 0; k < 150 && placed.length < 26; k++) {
      const x = R(4, S - 4), y = R(4, S - 4), p = at(x, y);
      if (p < 0 || kind[p] !== K_CITY || id[p] !== c.id) continue;
      const w = R(6, 12), h = R(5, 8.5), rad = Math.hypot(w, h) * 0.5;
      if (df[p] < rad * 0.82 + 2.2) continue;
      if (blocked.some((b) => Math.hypot(b.x - x, b.y - y) < b.r + rad * 0.6)) continue;
      if (placed.some((o) => Math.hypot(o.x - x, o.y - y) < (Math.hypot(o.w, o.h) * 0.5 + rad) * 0.9)) continue;
      placed.push({ x, y, w, h, a: base + (rng.nextFloat() < 0.5 ? 0 : Math.PI / 2) + R(-0.18, 0.18), roof: rng.nextInt(0, 3), seed: rng.nextUint32() });
    }
    d.houses.push(...placed);
  }
  // ---- towers along walls with a controlled spacing, away from tile borders.
  for (const c of g.shapes.cities) for (const wall of c.walls) {
    let acc = 0, next = R(10, 16);
    for (let i = 1; i < wall.length; i++) {
      acc += Math.hypot(wall[i].x - wall[i - 1].x, wall[i].y - wall[i - 1].y);
      const p = wall[i];
      if (acc >= next) {
        next = acc + R(23, 31);
        if (Math.min(p.x, p.y, S - p.x, S - p.y) < 9) continue;
        if (g.shapes.gates.some((gt) => Math.hypot(gt.x - p.x, gt.y - p.y) < 9)) continue;
        d.towers.push({ x: p.x, y: p.y, r: R(4, 5) });
      }
    }
  }
  // ---- hamlet around village / junction terminals (decorative buildings standing in the field).
  for (const term of g.shapes.terminals) {
    const n = term.kind === "village" ? rng.nextInt(3, 5) : rng.nextInt(0, 2);
    for (let k = 0, tries = 0; k < n && tries < 30; tries++) {
      const ang = R(0, Math.PI * 2), rr = term.r + R(5, 9);
      const x = term.x + Math.cos(ang) * rr, y = term.y + Math.sin(ang) * rr, p = at(x, y);
      if (p < 0 || kind[p] !== K_FIELD || df[p] < 5.5) continue;
      if (d.houses.some((o) => Math.hypot(o.x - x, o.y - y) < 9)) continue;
      d.houses.push({ x, y, w: R(6, 8.5), h: R(5, 6.5), a: ang + Math.PI / 2 + R(-0.3, 0.3), roof: rng.nextInt(0, 3), seed: rng.nextUint32() });
      k++;
    }
  }
  // ---- fields: crop patches, then forests driven by world-space noise (continuous across tiles).
  const occupied = (x: number, y: number, r: number) => d.houses.some((o) => Math.hypot(o.x - x, o.y - y) < r + 6);
  for (let k = 0; k < 14 && d.crops.length < 2; k++) {
    const x = R(14, S - 14), y = R(14, S - 14), w = R(16, 28), h = R(11, 18), a = R(0, Math.PI);
    let ok = true;
    for (let u = -1; u <= 1 && ok; u++) for (let v = -1; v <= 1 && ok; v++) {
      const px = x + (u * w * 0.5) * Math.cos(a) - (v * h * 0.5) * Math.sin(a), py = y + (u * w * 0.5) * Math.sin(a) + (v * h * 0.5) * Math.cos(a);
      const p = at(px, py);
      if (p < 0 || kind[p] !== K_FIELD || df[p] < 3) ok = false;
    }
    if (!ok || occupied(x, y, Math.max(w, h) * 0.5) || d.crops.some((o) => Math.hypot(o.x - x, o.y - y) < 30)) continue;
    d.crops.push({ x, y, w, h, a, c: rng.nextInt(0, 2) });
  }
  const inCrop = (x: number, y: number) => d.crops.some((o) => Math.hypot(o.x - x, o.y - y) < Math.max(o.w, o.h) * 0.62);
  for (let k = 0; k < 110; k++) {
    const x = R(3, S - 3), y = R(3, S - 3), p = at(x, y);
    if (p < 0 || kind[p] !== K_FIELD || df[p] < 4) continue;
    const w = world({ x, y });
    const density = fbm(w.x / 110, w.y / 110, FOREST_SEED, 3);
    if (rng.nextFloat() > Math.pow(Math.max(0, density - 0.32) * 2.4, 1.6) + 0.035) continue;
    const r = R(3.2, 5.6);
    if (inCrop(x, y) || occupied(x, y, r) || d.trees.some((o) => Math.hypot(o.x - x, o.y - y) < (o.r + r) * 0.85)) continue;
    d.trees.push({ x, y, r, conifer: fbm(w.x / 70 + 40, w.y / 70, FOREST_SEED + 7, 2) > 0.56, tone: rng.nextFloat() });
  }
  for (let k = 0; k < 16; k++) {
    const x = R(3, S - 3), y = R(3, S - 3), p = at(x, y);
    if (p < 0 || kind[p] !== K_FIELD || df[p] < 2.5 || inCrop(x, y) || occupied(x, y, 2)) continue;
    const roll = rng.nextFloat();
    if (roll < 0.35) d.bushes.push({ x, y, r: R(1.6, 2.8) });
    else if (roll < 0.9) d.flowers.push({ x, y, c: rng.nextInt(0, 2) });
    else d.rocks.push({ x, y, r: R(1.2, 2.2) });
  }
  // ---- rotate everything into world orientation.
  const rot = rotation & 3;
  if (rot) {
    const turn = <T extends Pt>(o: T): T => ({ ...o, ...rotatePoint(o, rot) });
    const turnA = <T extends Pt & { a: number }>(o: T): T => ({ ...o, ...rotatePoint(o, rot), a: o.a + (rot * Math.PI) / 2 });
    d.houses = d.houses.map(turnA); d.crops = d.crops.map(turnA);
    d.towers = d.towers.map(turn); d.trees = d.trees.map(turn); d.bushes = d.bushes.map(turn);
    d.flowers = d.flowers.map(turn); d.rocks = d.rocks.map(turn); d.shields = d.shields.map(turn); d.keeps = d.keeps.map(turn);
  }
  return d;
}
