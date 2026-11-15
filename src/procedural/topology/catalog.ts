/**
 * Compact catalogue of abstract topologies, computed once at start-up (no images).
 * Only one representative per rotation class is stored (lexicographically smallest id);
 * a tile instance is (canonical topology id, rotation).
 */
import { Terrain } from "../../core/types";
import type { Side, TileEdges, TileTopology } from "../../core/types";
import { rotatePort } from "../../core/coordinates";
import { buildTopology, edgesToString, enumerateSpecs, parseSpecId, rotateSpec, specId } from "./generator";
import type { TopologySpec } from "./generator";

export interface CatalogEntry {
  topology: TileTopology;
  spec: TopologySpec;
  /** Number of distinct orientations (1, 2 or 4). */
  symmetry: number;
  /** Structural statistics used for deck weighting. */
  stats: TopologyStats;
}

export interface TopologyStats {
  citySides: number;
  roadSides: number;
  grassSides: number;
  shields: number;
  monastery: boolean;
  junction: boolean;
  throughCity: boolean;
  regions: number;
}

export function canonicalSpec(spec: TopologySpec): { spec: TopologySpec; rotation: number } {
  let best = spec, bestId = specId(spec), rot = 0;
  for (let r = 1; r < 4; r++) {
    const cand = rotateSpec(spec, r);
    const id = specId(cand);
    if (id < bestId) { best = cand; bestId = id; rot = r; }
  }
  return { spec: best, rotation: rot };
}

function statsOf(t: TileTopology): TopologyStats {
  const count = (k: Terrain) => t.edges.filter((e) => e === k).length;
  return {
    citySides: count(Terrain.CITY),
    roadSides: count(Terrain.ROAD),
    grassSides: count(Terrain.GRASS),
    shields: t.cities.reduce((n, c) => n + c.shields, 0),
    monastery: t.monastery,
    junction: t.terminals.some((x) => x.kind === "junction"),
    throughCity: t.cities.some((c) => c.sides.length === 2 && ((c.sides[0] + 2) & 3) === c.sides[1]),
    regions: t.cities.length + t.roads.length + t.fields.length + (t.monastery ? 1 : 0),
  };
}

export const ALL_EDGE_CONFIGS: TileEdges[] = (() => {
  const out: TileEdges[] = [];
  for (let n = 0; n < 3; n++) for (let e = 0; e < 3; e++) for (let s = 0; s < 3; s++) for (let w = 0; w < 3; w++)
    out.push([n, e, s, w] as unknown as TileEdges);
  return out;
})();

function build(): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const edges of ALL_EDGE_CONFIGS) {
    for (const raw of enumerateSpecs(edges)) {
      const { spec } = canonicalSpec(raw);
      const id = specId(spec);
      if (map.has(id)) continue;
      const topology = buildTopology(spec);
      const ids = new Set([0, 1, 2, 3].map((r) => specId(rotateSpec(spec, r))));
      map.set(id, { topology, spec, symmetry: ids.size, stats: statsOf(topology) });
    }
  }
  return new Map([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

let cached: Map<string, CatalogEntry> | null = null;
export function catalog(): Map<string, CatalogEntry> {
  return (cached ??= build());
}

export function getEntry(id: string): CatalogEntry {
  const e = catalog().get(id);
  if (!e) throw new Error("Unknown topology id: " + id);
  return e;
}
export function getTopology(id: string): TileTopology {
  return getEntry(id).topology;
}

/** Canonical id of an arbitrary (possibly rotated) spec or id. */
export function canonicalId(idOrSpec: string | TopologySpec): string {
  const spec = typeof idOrSpec === "string" ? parseSpecId(idOrSpec) : idOrSpec;
  return specId(canonicalSpec(spec).spec);
}

const rotatedCache = new Map<string, TileTopology>();
/** Topology after r clockwise quarter turns. Region ids are preserved. */
export function rotateTopology(t: TileTopology, r: number): TileTopology {
  r &= 3;
  if (r === 0) return t;
  const key = t.id + "@" + r;
  let out = rotatedCache.get(key);
  if (out) return out;
  const rs = (s: Side) => ((s + r) & 3) as Side;
  const edges = [0, 0, 0, 0] as Terrain[];
  for (let s = 0; s < 4; s++) edges[(s + r) & 3] = t.edges[s];
  out = {
    id: t.id,
    edges: edges as unknown as TileEdges,
    cities: t.cities.map((c) => ({ ...c, sides: c.sides.map(rs) })),
    roads: t.roads.map((x) => ({ ...x, sides: x.sides.map(rs) })),
    fields: t.fields.map((f) => ({ ...f, ports: f.ports.map((p) => rotatePort(p, r)) })),
    terminals: t.terminals,
    monastery: t.monastery,
  };
  rotatedCache.set(key, out);
  return out;
}

export function rotatedById(id: string, r: number): TileTopology {
  return rotateTopology(getTopology(id), r);
}

/** For every one of the 81 edge strings: the (canonical id, rotation) pairs producing it. */
let byEdges: Map<string, { id: string; rotation: number }[]> | null = null;
export function topologiesForEdges(edges: TileEdges): { id: string; rotation: number }[] {
  if (!byEdges) {
    byEdges = new Map();
    for (const [id, e] of catalog()) {
      const seen = new Set<string>();
      for (let r = 0; r < 4; r++) {
        const key = edgesToString(rotateTopology(e.topology, r).edges);
        const sig = key + specId(rotateSpec(e.spec, r));
        if (seen.has(sig)) continue;
        seen.add(sig);
        if (!byEdges.has(key)) byEdges.set(key, []);
        byEdges.get(key)!.push({ id, rotation: r });
      }
    }
  }
  return byEdges.get(edgesToString(edges)) ?? [];
}

/**
 * Logical composition of the classic 72-tile base deck (letters follow the usual A..X
 * reference sheet). Only descriptors and multiplicities: no artwork.
 */
const CLASSIC_RAW: [string, string, number][] = [
  ["A", "FFRF-e2m-m", 2],
  ["B", "FFFF-m", 4],
  ["C", "CCCC-c0123s", 1],
  ["D", "CRFR-c0-r13", 4],
  ["E", "CFFF-c0", 5],
  ["F", "FCFC-c13s", 2],
  ["G", "CFCF-c02", 1],
  ["H", "FCFC-c1.3", 3],
  ["I", "FCCF-c1.2", 2],
  ["J", "CRRF-c0-r12", 3],
  ["K", "CFRR-c0-r23", 3],
  ["L", "CRRR-c0-e123j", 3],
  ["M", "CFFC-c03s", 2],
  ["N", "CFFC-c03", 3],
  ["O", "CRRC-c03s-r12", 2],
  ["P", "CRRC-c03-r12", 3],
  ["Q", "CCFC-c013s", 1],
  ["R", "CCFC-c013", 3],
  ["S", "CCRC-c013s-e2g0", 2],
  ["T", "CCRC-c013-e2g0", 1],
  ["U", "RFRF-r02", 8],
  ["V", "FFRR-r23", 9],
  ["W", "FRRR-e123j", 4],
  ["X", "RRRR-e0123j", 1],
];

export interface ClassicTile {
  letter: string;
  id: string;
  count: number;
}
let classic: ClassicTile[] | null = null;
export function classicComposition(): ClassicTile[] {
  if (!classic) {
    classic = CLASSIC_RAW.map(([letter, raw, count]) => {
      const id = canonicalId(raw);
      getEntry(id);
      return { letter, id, count };
    });
  }
  return classic;
}
/** The classic starting tile (letter D): city north, road east-west. */
export function startTopologyId(): string {
  return canonicalId("CRFR-c0-r13");
}
