/**
 * Independent geometry validator.
 * It knows nothing about how shapes were generated: it reads a logical raster mask,
 * rebuilds the topology (interfaces, connected regions, physical and score connectivity of
 * roads, field components, field/city adjacency) and compares it with the expected one.
 */
import { Terrain } from "../../core/types";
import type { TileTopology } from "../../core/types";
import { TILE_SIZE } from "../../core/types";
import { K_CITY, K_FIELD, K_MONASTERY, K_ROAD, K_TERMINAL, components } from "./masks";
import type { TileMask } from "./masks";

/** Corner transition zone (nominal px) excluded from interface checks. */
export const CORNER_ZONE = 7;
/** Minimal clearance (nominal px) between regions that must not touch. */
export const MIN_CLEARANCE = 2;

export interface ReconstructedField { ports: number[]; adjacentCityIds: number[]; area: number }
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  fields: ReconstructedField[];
  /** Road ids grouped by physical contact. */
  roadGroups: number[][];
  /** For each reconstructed field component: the matching declared field id (or -1). */
  fieldIds: number[];
  /** Component label of every pixel and component index of each reconstructed field. */
  label: Int32Array;
  fieldComps: number[];
}

/** Pixel index of the border sample at clockwise index k along side s. */
export function borderPixel(res: number, s: number, k: number): number {
  switch (s) {
    case 0: return k;
    case 1: return k * res + (res - 1);
    case 2: return (res - 1) * res + (res - 1 - k);
    default: return (res - 1 - k) * res;
  }
}

export function validateMask(t: TileTopology, mask: TileMask): ValidationResult {
  const { res, kind, id } = mask;
  const scale = res / TILE_SIZE;
  const errors: string[] = [];
  const err = (m: string) => { if (errors.length < 24) errors.push(m); };
  const cityOfSide = [-1, -1, -1, -1], roadOfSide = [-1, -1, -1, -1];
  for (const c of t.cities) for (const s of c.sides) cityOfSide[s] = c.id;
  for (const r of t.roads) for (const s of r.sides) roadOfSide[s] = r.id;

  // 1. Edge profiles.
  for (let s = 0; s < 4; s++) {
    const terrain = t.edges[s];
    let bad = 0;
    for (let k = 0; k < res; k++) {
      const tc = (k + 0.5) / scale;
      const p = borderPixel(res, s, k);
      const kd = kind[p], rid = id[p];
      const off = Math.abs(tc - TILE_SIZE / 2);
      const inCorner = tc < CORNER_ZONE || tc > TILE_SIZE - CORNER_ZONE;
      if (kd === K_TERMINAL || kd === K_MONASTERY) { bad++; continue; }
      if (kd === K_ROAD && !(terrain === Terrain.ROAD && off <= 9 && rid === roadOfSide[s])) { bad++; continue; }
      if (inCorner) continue;
      if (terrain === Terrain.GRASS) { if (kd !== K_FIELD) bad++; }
      else if (terrain === Terrain.CITY) { if (kd !== K_CITY || rid !== cityOfSide[s]) bad++; }
      else if (off <= 7) { if (kd !== K_ROAD) bad++; }
      else if (off >= 9) { if (kd !== K_FIELD) bad++; }
    }
    if (bad) err(`side ${s}: ${bad} border samples violate the ${Terrain[terrain]} profile`);
  }

  // 2. Components and adjacency.
  const { label, comps } = components(mask);
  const nc = comps.length;
  const adj = new Set<number>();
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const k = j * res + i, a = label[k];
    if (i + 1 < res) { const b = label[k + 1]; if (a !== b) { adj.add(a * nc + b); adj.add(b * nc + a); } }
    if (j + 1 < res) { const b = label[k + res]; if (a !== b) { adj.add(a * nc + b); adj.add(b * nc + a); } }
  }
  const compsOf = (kd: number, rid: number) => comps.map((c, i) => (c.kind === kd && c.id === rid ? i : -1)).filter((i) => i >= 0);
  const single = (kd: number, rid: number, name: string): number => {
    const list = compsOf(kd, rid);
    if (list.length !== 1) err(`${name}: expected one connected component, found ${list.length}`);
    return list[0] ?? -1;
  };
  const cityComp = t.cities.map((c) => single(K_CITY, c.id, `city ${c.id}`));
  const roadComp = t.roads.map((r) => single(K_ROAD, r.id, `road ${r.id}`));
  for (const c of comps) {
    if (c.kind === K_CITY && !t.cities.some((x) => x.id === c.id)) err("undeclared city region");
    if (c.kind === K_ROAD && !t.roads.some((x) => x.id === c.id)) err("undeclared road region");
  }
  const touching = (a: number, b: number) => a >= 0 && b >= 0 && adj.has(a * nc + b);

  const discTerminal = t.terminals.find((x) => x.kind === "junction" || x.kind === "village");
  const termComp = discTerminal ? single(K_TERMINAL, discTerminal.id, "terminal") : -1;
  if (!discTerminal && comps.some((c) => c.kind === K_TERMINAL)) err("undeclared terminal disc");
  let monComp = -1;
  if (t.monastery) {
    monComp = single(K_MONASTERY, 0, "monastery");
    if (monComp >= 0 && comps[monComp].touchesBorder) err("monastery touches the tile border");
  } else if (comps.some((c) => c.kind === K_MONASTERY)) err("undeclared monastery");

  // 3. Roads: terminals, gates and forbidden contacts.
  t.roads.forEach((r, ri) => {
    const term = r.terminalIds.length ? t.terminals.find((x) => x.id === r.terminalIds[0])! : null;
    t.cities.forEach((c, ci) => {
      const gate = term?.kind === "cityGate" && term.cityId === c.id;
      const touch = touching(roadComp[ri], cityComp[ci]);
      if (gate && !touch) err(`road ${r.id} does not reach its gate in city ${c.id}`);
      if (!gate && touch) err(`road ${r.id} touches city ${c.id} outside a gate`);
    });
    const tm = touching(roadComp[ri], monComp);
    if (term?.kind === "monastery" ? !tm : tm) err(`road ${r.id}: wrong monastery contact`);
    const tt = touching(roadComp[ri], termComp);
    const wantDisc = term?.kind === "junction" || term?.kind === "village";
    if (wantDisc ? !tt : tt) err(`road ${r.id}: wrong terminal contact`);
  });
  for (let a = 0; a < t.cities.length; a++) for (let b = a + 1; b < t.cities.length; b++)
    if (touching(cityComp[a], cityComp[b])) err(`cities ${a} and ${b} touch`);

  // 4. Physical road groups (score connectivity is the road id itself, checked by `single`).
  const parent = t.roads.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let a = 0; a < t.roads.length; a++) for (let b = a + 1; b < t.roads.length; b++) {
    if (touching(roadComp[a], roadComp[b]) || (termComp >= 0 && touching(roadComp[a], termComp) && touching(roadComp[b], termComp)))
      parent[find(a)] = find(b);
  }
  const groupsOf = (key: (i: number) => number) => {
    const m = new Map<number, number[]>();
    t.roads.forEach((r, i) => { const k = key(i); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r.id); });
    return [...m.values()].map((g) => g.sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
  };
  const roadGroups = groupsOf(find);
  const expectedGroups = groupsOf((i) => {
    const r = t.roads[i];
    const term = r.terminalIds.length ? t.terminals.find((x) => x.id === r.terminalIds[0])! : null;
    return term && term.kind === "junction" ? -1 : i;
  });
  if (JSON.stringify(roadGroups) !== JSON.stringify(expectedGroups)) err(`physical road groups ${JSON.stringify(roadGroups)} != ${JSON.stringify(expectedGroups)}`);

  // 5. Minimal clearance between regions that are not allowed to touch.
  const allowed = (a: number, b: number): boolean => {
    const ca = comps[a], cb = comps[b];
    if (ca.kind === K_FIELD || cb.kind === K_FIELD) return true;
    if (ca.kind === K_ROAD && cb.kind === K_ROAD) return find(t.roads.findIndex((r) => r.id === ca.id)) === find(t.roads.findIndex((r) => r.id === cb.id));
    const road = ca.kind === K_ROAD ? ca : cb.kind === K_ROAD ? cb : null;
    const other = road === ca ? cb : ca;
    if (!road) return false;
    const r = t.roads.find((x) => x.id === road.id);
    const term = r && r.terminalIds.length ? t.terminals.find((x) => x.id === r.terminalIds[0])! : null;
    if (!term) return false;
    if (other.kind === K_TERMINAL) return term.kind === "junction" || term.kind === "village";
    if (other.kind === K_MONASTERY) return term.kind === "monastery";
    if (other.kind === K_CITY) return term.kind === "cityGate" && term.cityId === other.id;
    return false;
  };
  const rad = Math.max(1, Math.round(MIN_CLEARANCE * scale));
  const badPairs = new Set<number>();
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const k = j * res + i;
    if (kind[k] === K_FIELD) continue;
    const a = label[k];
    for (let dy = 0; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (dy === 0 && dx <= 0) continue;
      const x = i + dx, y = j + dy;
      if (x < 0 || x >= res || y >= res) continue;
      const q = y * res + x;
      if (kind[q] === K_FIELD) continue;
      const b = label[q];
      if (a !== b && !badPairs.has(a * nc + b) && !allowed(a, b)) { badPairs.add(a * nc + b); badPairs.add(b * nc + a); }
    }
  }
  if (badPairs.size) {
    const [first] = badPairs;
    const a = comps[Math.floor(first / nc)], b = comps[first % nc];
    err(`insufficient clearance between region ${a.kind}:${a.id} and ${b.kind}:${b.id}`);
  }

  // 6. Fields = connected components of what is left.
  const fieldComps: number[] = [];
  comps.forEach((c, i) => { if (c.kind === K_FIELD) fieldComps.push(i); });
  const fields: ReconstructedField[] = fieldComps.map((ci) => ({ ports: [], adjacentCityIds: [], area: comps[ci].area }));
  const minArea = 20 * scale * scale;
  fieldComps.forEach((ci, fi) => {
    if (comps[ci].area < minArea) err(`sliver field component (${comps[ci].area} px)`);
    t.cities.forEach((c, k) => { if (touching(ci, cityComp[k])) fields[fi].adjacentCityIds.push(c.id); });
  });
  for (let p = 0; p < 8; p++) {
    const s = p >> 1;
    if (t.edges[s] === Terrain.CITY) continue;
    const tc = p & 1 ? 96 : 32;
    const px = borderPixel(res, s, Math.floor(tc * scale));
    const fi = fieldComps.indexOf(label[px]);
    if (fi < 0) err(`field port ${p} is not on a field`);
    else fields[fi].ports.push(p);
  }
  const key = (ports: number[], adjc: number[]) => [...ports].sort((a, b) => a - b).join("") + "|" + [...adjc].sort((a, b) => a - b).join("");
  const remaining = t.fields.map((f) => ({ id: f.id, key: key(f.ports, f.adjacentCityIds) }));
  const fieldIds = fields.map((f) => {
    const k = key(f.ports, f.adjacentCityIds);
    const idx = remaining.findIndex((r) => r.key === k);
    if (idx < 0) { err(`unexpected field {ports ${f.ports.join(",")}; cities ${f.adjacentCityIds.join(",")}}`); return -1; }
    return remaining.splice(idx, 1)[0].id;
  });
  for (const r of remaining) err(`missing field ${r.id} (${r.key})`);

  return { ok: errors.length === 0, errors, fields, roadGroups, fieldIds, label, fieldComps };
}
