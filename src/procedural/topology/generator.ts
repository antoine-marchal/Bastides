/**
 * Combinatorial generator of abstract tile topologies.
 *
 * For one edge configuration it enumerates
 *   - non-crossing partitions of the CITY sides,
 *   - road structures (through roads, stubs, shared junction),
 *   - terminals (village, junction, city gate, monastery), monasteries and shields,
 * evaluates the partitions of all terrains JOINTLY for planarity, then derives the field
 * regions as the faces left between the obstacle groups (never generated independently).
 *
 * Topology id format (stable, versioned by GENERATOR_VERSION):
 *   EDGES[-c<block>.<block>][-r<pair>.<pair>][-e<stubs><end>][-m]
 *   EDGES : four letters N,E,S,W among F (grass), R (road), C (city)
 *   block : city sides as digits, suffix "s" when the region carries a shield
 *   pair  : two sides joined by a through road
 *   end   : v village, j junction, g<n> gate into city n, m monastery
 */
import { Terrain } from "../../core/types";
import type { CityRegion, FieldRegion, RoadRegion, RoadTerminal, Side, TileEdges, TileTopology } from "../../core/types";
import { isNonCrossing, matchings, setPartitions } from "./partitions";

export type StubEnd = "" | "v" | "j" | "g" | "m";

export interface TopologySpec {
  edges: TileEdges;
  cityBlocks: Side[][];
  shields: boolean[];
  pairs: [Side, Side][];
  stubs: Side[];
  stubEnd: StubEnd;
  gateCity: number;
  monastery: boolean;
}

const LETTER = ["F", "R", "C"];

export function edgesToString(e: TileEdges): string {
  return e.map((t) => LETTER[t]).join("");
}
export function edgesFromString(s: string): TileEdges {
  if (!/^[FRC]{4}$/.test(s)) throw new Error("bad edges: " + s);
  return [...s].map((c) => LETTER.indexOf(c)) as unknown as TileEdges;
}

export function normalizeSpec(spec: TopologySpec): TopologySpec {
  const idx = spec.cityBlocks.map((_, i) => i);
  const blocks = spec.cityBlocks.map((b) => [...b].sort((a, b) => a - b));
  idx.sort((i, j) => blocks[i][0] - blocks[j][0]);
  const pairs = spec.pairs
    .map((p) => (p[0] < p[1] ? [p[0], p[1]] : [p[1], p[0]]) as [Side, Side])
    .sort((a, b) => a[0] - b[0]);
  return {
    edges: spec.edges,
    cityBlocks: idx.map((i) => blocks[i]),
    shields: idx.map((i) => !!spec.shields[i]),
    pairs,
    stubs: [...spec.stubs].sort((a, b) => a - b),
    stubEnd: spec.stubEnd,
    gateCity: spec.gateCity < 0 ? -1 : idx.indexOf(spec.gateCity),
    monastery: spec.monastery,
  };
}

export function rotateSpec(spec: TopologySpec, r: number): TopologySpec {
  const rs = (s: Side) => ((s + r) & 3) as Side;
  const edges = [0, 0, 0, 0] as Terrain[];
  for (let s = 0; s < 4; s++) edges[(s + r) & 3] = spec.edges[s];
  return normalizeSpec({
    edges: edges as unknown as TileEdges,
    cityBlocks: spec.cityBlocks.map((b) => b.map(rs)),
    shields: [...spec.shields],
    pairs: spec.pairs.map((p) => [rs(p[0]), rs(p[1])] as [Side, Side]),
    stubs: spec.stubs.map(rs),
    stubEnd: spec.stubEnd,
    gateCity: spec.gateCity,
    monastery: spec.monastery,
  });
}

export function specId(specIn: TopologySpec): string {
  const s = normalizeSpec(specIn);
  let id = edgesToString(s.edges);
  if (s.cityBlocks.length) id += "-c" + s.cityBlocks.map((b, i) => b.join("") + (s.shields[i] ? "s" : "")).join(".");
  if (s.pairs.length) id += "-r" + s.pairs.map((p) => p.join("")).join(".");
  if (s.stubs.length) id += "-e" + s.stubs.join("") + s.stubEnd + (s.stubEnd === "g" ? s.gateCity : "");
  if (s.monastery) id += "-m";
  return id;
}

/** Inverse of specId. Throws on malformed ids. */
export function parseSpecId(id: string): TopologySpec {
  const parts = id.split("-");
  const spec: TopologySpec = {
    edges: edgesFromString(parts[0]), cityBlocks: [], shields: [], pairs: [], stubs: [],
    stubEnd: "", gateCity: -1, monastery: false,
  };
  for (const p of parts.slice(1)) {
    const body = p.slice(1);
    if (p[0] === "c") {
      for (const b of body.split(".")) {
        spec.shields.push(b.endsWith("s"));
        spec.cityBlocks.push([...b.replace("s", "")].map((d) => Number(d) as Side));
      }
    } else if (p[0] === "r") {
      for (const b of body.split(".")) spec.pairs.push([Number(b[0]) as Side, Number(b[1]) as Side]);
    } else if (p[0] === "e") {
      const m = /^(\d+)([vjgm])(\d?)$/.exec(body);
      if (!m) throw new Error("bad topology id: " + id);
      spec.stubs = [...m[1]].map((d) => Number(d) as Side);
      spec.stubEnd = m[2] as StubEnd;
      spec.gateCity = m[2] === "g" ? Number(m[3]) : -1;
    } else if (p === "m") spec.monastery = true;
    else throw new Error("bad topology id: " + id);
  }
  return spec;
}

/** Groups of sides that are physically linked inside the tile (obstacles for the fields). */
export function physicalGroups(s: TopologySpec): Side[][] {
  const groups: Side[][] = s.cityBlocks.map((b) => [...b]);
  for (const p of s.pairs) groups.push([p[0], p[1]]);
  if (s.stubs.length >= 2) groups.push([...s.stubs]);
  else if (s.stubs.length === 1) {
    if (s.stubEnd === "g") groups[s.gateCity].push(s.stubs[0]);
    else groups.push([s.stubs[0]]);
  }
  return groups;
}

interface Gap {
  ports: number[];
  prev: Side;
  next: Side;
  degenerate: boolean;
}

/** Faces between obstacle groups: each face is a set of gaps (boundary arcs between attachments). */
function computeFaces(s: TopologySpec): { gaps: Gap[]; faceOf: number[]; faceCount: number } {
  const groups = physicalGroups(s);
  const groupOf = new Map<number, number>();
  groups.forEach((g, i) => g.forEach((side) => groupOf.set(side, i)));
  const cityOf = new Map<number, number>();
  s.cityBlocks.forEach((b, i) => b.forEach((side) => cityOf.set(side, i)));

  // Clockwise boundary sequence: ports and attachments.
  type Item = { port: number } | { att: Side };
  const seq: Item[] = [];
  for (let side = 0; side < 4; side++) {
    const t = s.edges[side];
    if (t === Terrain.GRASS) seq.push({ port: side * 2 }, { port: side * 2 + 1 });
    else if (t === Terrain.ROAD) seq.push({ port: side * 2 }, { att: side as Side }, { port: side * 2 + 1 });
    else seq.push({ att: side as Side });
  }
  const attIdx = seq.map((it, i) => ("att" in it ? i : -1)).filter((i) => i >= 0);
  if (attIdx.length === 0) {
    return { gaps: [{ ports: [0, 1, 2, 3, 4, 5, 6, 7], prev: 0, next: 0, degenerate: false }], faceOf: [0], faceCount: 1 };
  }
  const m = attIdx.length;
  const atts = attIdx.map((i) => (seq[i] as { att: Side }).att);
  const gaps: Gap[] = [];
  for (let k = 0; k < m; k++) {
    const from = attIdx[k], to = attIdx[(k + 1) % m];
    const ports: number[] = [];
    for (let i = (from + 1) % seq.length; i !== to; i = (i + 1) % seq.length) ports.push((seq[i] as { port: number }).port);
    const prev = atts[k], next = atts[(k + 1) % m];
    const degenerate = m > 1 && ports.length === 0 && cityOf.has(prev) && cityOf.get(prev) === cityOf.get(next);
    gaps.push({ ports, prev, next, degenerate: degenerate || (m === 1 && false) });
  }
  // Gap k lies between attachment k and k+1. Gaps i<j share a face iff no group has
  // attachments on both arcs (i+1..j) and (j+1..i).
  const parent = gaps.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (gaps[i].degenerate || gaps[j].degenerate) continue;
      const inside = new Set<number>();
      for (let k = i + 1; k <= j; k++) inside.add(groupOf.get(atts[k])!);
      let separated = false;
      for (let k = j + 1; k <= i + m; k++) if (inside.has(groupOf.get(atts[k % m])!)) { separated = true; break; }
      if (!separated) parent[find(i)] = find(j);
    }
  }
  const faceIds = new Map<number, number>();
  const faceOf = gaps.map((g, i) => {
    if (g.degenerate) return -1;
    const r = find(i);
    if (!faceIds.has(r)) faceIds.set(r, faceIds.size);
    return faceIds.get(r)!;
  });
  return { gaps, faceOf, faceCount: faceIds.size };
}

/** Build the full topology (regions with stable local ids) from a spec. */
export function buildTopology(specIn: TopologySpec): TileTopology {
  const s = normalizeSpec(specIn);
  const cities: CityRegion[] = s.cityBlocks.map((b, i) => ({ id: i, sides: [...b], shields: s.shields[i] ? 1 : 0 }));
  const terminals: RoadTerminal[] = [];
  const roads: RoadRegion[] = [];
  for (const p of s.pairs) roads.push({ id: roads.length, sides: [p[0], p[1]], terminalIds: [] });
  if (s.stubs.length) {
    const kind = s.stubEnd === "j" ? "junction" : s.stubEnd === "g" ? "cityGate" : s.stubEnd === "m" ? "monastery" : "village";
    const t: RoadTerminal = { id: 0, kind };
    if (kind === "cityGate") t.cityId = s.gateCity;
    terminals.push(t);
    for (const side of s.stubs) roads.push({ id: roads.length, sides: [side], terminalIds: [0] });
  }
  const cityOf = new Map<number, number>();
  s.cityBlocks.forEach((b, i) => b.forEach((side) => cityOf.set(side, i)));
  const { gaps, faceOf, faceCount } = computeFaces(s);
  const fields: FieldRegion[] = [];
  for (let f = 0; f < faceCount; f++) fields.push({ id: f, ports: [], adjacentCityIds: [] });
  gaps.forEach((g, i) => {
    const f = faceOf[i];
    if (f < 0) return;
    fields[f].ports.push(...g.ports);
    for (const side of [g.prev, g.next]) {
      const c = cityOf.get(side);
      if (c !== undefined && s.edges[side] === Terrain.CITY && !fields[f].adjacentCityIds.includes(c)) fields[f].adjacentCityIds.push(c);
    }
  });
  if (s.edges.every((t) => t === Terrain.GRASS)) fields[0].adjacentCityIds = [];
  // Order fields deterministically: by smallest port, port-less faces last.
  for (const f of fields) { f.ports.sort((a, b) => a - b); f.adjacentCityIds.sort((a, b) => a - b); }
  fields.sort((a, b) => (a.ports[0] ?? 99) - (b.ports[0] ?? 99) || (a.adjacentCityIds[0] ?? 0) - (b.adjacentCityIds[0] ?? 0));
  fields.forEach((f, i) => (f.id = i));
  return { id: specId(s), edges: s.edges, cities, roads, fields, terminals, monastery: s.monastery };
}

/** Enumerate every accepted topology spec of one edge configuration. */
export function enumerateSpecs(edges: TileEdges): TopologySpec[] {
  const citySides = ([0, 1, 2, 3] as Side[]).filter((s) => edges[s] === Terrain.CITY);
  const roadSides = ([0, 1, 2, 3] as Side[]).filter((s) => edges[s] === Terrain.ROAD);
  const out: TopologySpec[] = [];
  const seen = new Set<string>();
  const push = (spec: TopologySpec) => {
    const n = normalizeSpec(spec);
    if (!isRealisable(n)) return;
    const id = specId(n);
    if (!seen.has(id)) { seen.add(id); out.push(n); }
  };
  for (const cityBlocks of setPartitions(citySides)) {
    if (!isNonCrossing(cityBlocks)) continue;
    const multi = cityBlocks.map((b, i) => (b.length >= 2 ? i : -1)).filter((i) => i >= 0);
    const shieldOptions: boolean[][] = [];
    for (let mask = 0; mask < 1 << multi.length; mask++) {
      const sh = cityBlocks.map(() => false);
      multi.forEach((ci, bit) => { if (mask & (1 << bit)) sh[ci] = true; });
      shieldOptions.push(sh);
    }
    for (const m of matchings(roadSides)) {
      if (m.pairs.length && m.singles.length) continue; // no mix of through roads and stubs
      const base = { edges, cityBlocks, pairs: m.pairs as [Side, Side][], stubs: m.singles as Side[] };
      const ends: { stubEnd: StubEnd; gateCity: number; monastery: boolean }[] = [];
      const monasteryOk = cityBlocks.length <= 1 && citySides.length <= 1 && roadSides.length <= 1;
      if (m.singles.length === 0) {
        ends.push({ stubEnd: "", gateCity: -1, monastery: false });
        if (monasteryOk) ends.push({ stubEnd: "", gateCity: -1, monastery: true });
      } else if (m.singles.length === 1) {
        ends.push({ stubEnd: "v", gateCity: -1, monastery: false });
        cityBlocks.forEach((_, ci) => ends.push({ stubEnd: "g", gateCity: ci, monastery: false }));
        if (monasteryOk) ends.push({ stubEnd: "m", gateCity: -1, monastery: true });
      } else ends.push({ stubEnd: "j", gateCity: -1, monastery: false });
      for (const e of ends) for (const shields of shieldOptions) push({ ...base, shields, ...e });
    }
  }
  return out;
}

/** Joint planarity and available-surface rules. */
export function isRealisable(s: TopologySpec): boolean {
  const groups = physicalGroups(s);
  if (!isNonCrossing(groups)) return false;
  const cityOf = new Map<number, number>();
  s.cityBlocks.forEach((b, i) => b.forEach((side) => cityOf.set(side, i)));
  if (s.stubs.length === 1) {
    const side = s.stubs[0];
    const l = cityOf.get((side + 3) & 3), r = cityOf.get((side + 1) & 3);
    const inLens = l !== undefined && l === r;
    // A stub squeezed in the lens of a single city has no room for a village: it must be a gate.
    if (inLens && s.stubEnd !== "g") return false;
    if (s.stubEnd === "g") {
      // The gate city must border the face that contains the road side (computed without the road).
      const without: TopologySpec = { ...s, stubs: [], stubEnd: "", gateCity: -1 };
      const grassEdges = s.edges.map((t, i) => (i === side ? Terrain.GRASS : t)) as unknown as TileEdges;
      const topo = buildTopology({ ...without, edges: grassEdges });
      const face = topo.fields.find((f) => f.ports.includes(side * 2));
      if (!face || !face.adjacentCityIds.includes(s.gateCity)) return false;
    }
  }
  if (s.monastery && (s.cityBlocks.length > 1 || s.cityBlocks.some((b) => b.length > 1))) return false;
  return true;
}
