/** Structural invariants of an abstract topology (independent from the generator). */
import { Terrain } from "../../core/types";
import type { TileTopology } from "../../core/types";

export function validateTopology(t: TileTopology): string[] {
  const errors: string[] = [];
  const err = (m: string) => errors.push(t.id + ": " + m);
  const cityOwner = new Map<number, number>();
  for (const c of t.cities) {
    if (!c.sides.length) err("city without side");
    for (const s of c.sides) {
      if (t.edges[s] !== Terrain.CITY) err(`city ${c.id} on non-city side ${s}`);
      if (cityOwner.has(s)) err(`side ${s} owned by two cities`);
      cityOwner.set(s, c.id);
    }
    if (c.shields < 0) err("negative shields");
  }
  const roadOwner = new Map<number, number>();
  for (const r of t.roads) {
    if (r.sides.length < 1 || r.sides.length > 2) err(`road ${r.id} must have 1 or 2 sides`);
    if (r.sides.length === 1 && r.terminalIds.length !== 1) err(`stub road ${r.id} needs exactly one terminal`);
    if (r.sides.length === 2 && r.terminalIds.length !== 0) err(`through road ${r.id} cannot have a terminal`);
    for (const s of r.sides) {
      if (t.edges[s] !== Terrain.ROAD) err(`road ${r.id} on non-road side ${s}`);
      if (roadOwner.has(s)) err(`side ${s} owned by two roads`);
      roadOwner.set(s, r.id);
    }
    for (const id of r.terminalIds) if (!t.terminals.some((x) => x.id === id)) err(`road ${r.id}: unknown terminal`);
  }
  for (let s = 0; s < 4; s++) {
    if (t.edges[s] === Terrain.CITY && !cityOwner.has(s)) err(`city side ${s} without region`);
    if (t.edges[s] === Terrain.ROAD && !roadOwner.has(s)) err(`road side ${s} without region`);
  }
  for (const term of t.terminals) {
    if (term.kind === "cityGate" && !t.cities.some((c) => c.id === term.cityId)) err("gate without city");
    if (term.kind === "monastery" && !t.monastery) err("monastery terminal without monastery");
    const users = t.roads.filter((r) => r.terminalIds.includes(term.id)).length;
    if (term.kind === "junction" && users < 2) err("junction with fewer than two roads");
    if (term.kind !== "junction" && users !== 1) err("non-junction terminal must end exactly one road");
  }
  const portOwner = new Map<number, number>();
  for (const f of t.fields) {
    for (const p of f.ports) {
      if (t.edges[p >> 1] === Terrain.CITY) err(`field port ${p} on a city side`);
      if (portOwner.has(p)) err(`port ${p} in two fields`);
      portOwner.set(p, f.id);
    }
    for (const c of f.adjacentCityIds) if (!t.cities.some((x) => x.id === c)) err("field adjacent to unknown city");
  }
  for (let s = 0; s < 4; s++) {
    if (t.edges[s] === Terrain.CITY) continue;
    const a = portOwner.get(s * 2), b = portOwner.get(s * 2 + 1);
    if (a === undefined || b === undefined) err(`side ${s}: missing field port`);
    if (t.edges[s] === Terrain.GRASS && a !== b) err(`grass side ${s}: its two ports must share a field`);
  }
  // Corner continuity: two neighbouring non-city sides always share the corner field.
  for (let s = 0; s < 4; s++) {
    const n = (s + 1) & 3;
    if (t.edges[s] !== Terrain.CITY && t.edges[n] !== Terrain.CITY && portOwner.get(s * 2 + 1) !== portOwner.get(n * 2))
      err(`corner ${s}: field ports around a grass corner must be connected`);
  }
  for (const c of t.cities) if (t.fields.length && !t.fields.some((f) => f.adjacentCityIds.includes(c.id)) && c.sides.length < 4)
    err(`city ${c.id} touches no field`);
  return errors;
}

/** Symmetric boolean matrix over the 4 main interfaces for one terrain (derived from partitions). */
export function mainContinuity(t: TileTopology, kind: "city" | "road"): boolean[][] {
  const m = [0, 1, 2, 3].map(() => [false, false, false, false]);
  for (const r of kind === "city" ? t.cities : t.roads) for (const a of r.sides) for (const b of r.sides) m[a][b] = true;
  return m;
}
/** 8x8 field-port continuity matrix (derived from the field partition). */
export function fieldContinuity(t: TileTopology): boolean[][] {
  const m = Array.from({ length: 8 }, () => new Array<boolean>(8).fill(false));
  for (const f of t.fields) for (const a of f.ports) for (const b of f.ports) m[a][b] = true;
  return m;
}
/** Physical road connectivity (roads sharing a junction are linked, unlike score connectivity). */
export function physicalRoadContinuity(t: TileTopology): boolean[][] {
  const m = mainContinuity(t, "road");
  for (const a of t.roads) for (const b of t.roads)
    if (a.terminalIds.some((id) => b.terminalIds.includes(id))) for (const x of a.sides) for (const y of b.sides) m[x][y] = true;
  return m;
}
