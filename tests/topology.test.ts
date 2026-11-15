import { describe, expect, it } from "vitest";
import { Terrain } from "../src/core/types";
import type { TileEdges } from "../src/core/types";
import { blocksCross, isNonCrossing, matchings, setPartitions } from "../src/procedural/topology/partitions";
import { buildTopology, edgesToString, enumerateSpecs, parseSpecId, rotateSpec, specId } from "../src/procedural/topology/generator";
import { ALL_EDGE_CONFIGS, canonicalId, catalog, classicComposition, getTopology, rotateTopology, topologiesForEdges } from "../src/procedural/topology/catalog";
import { fieldContinuity, mainContinuity, physicalRoadContinuity, validateTopology } from "../src/procedural/topology/validator";
import { matchingPort } from "../src/core/coordinates";

const topo = (id: string) => buildTopology(parseSpecId(id));
const fieldsOf = (id: string) => topo(id).fields.map((f) => f.ports.join(""));

describe("partitions", () => {
  it("counts set partitions (Bell numbers)", () => {
    expect([0, 1, 2, 3, 4].map((n) => setPartitions([...Array(n).keys()]).length)).toEqual([1, 1, 2, 5, 15]);
  });
  it("detects the single crossing partition of four points", () => {
    expect(blocksCross([0, 2], [1, 3])).toBe(true);
    expect(blocksCross([0, 1], [2, 3])).toBe(false);
    expect(setPartitions([0, 1, 2, 3]).filter(isNonCrossing).length).toBe(14);
  });
  it("enumerates partial matchings", () => {
    expect(matchings([0, 1, 2, 3]).length).toBe(10);
  });
});

describe("catalogue", () => {
  it("covers the 81 edge configurations and 24 rotation classes", () => {
    expect(ALL_EDGE_CONFIGS.length).toBe(81);
    const classes = new Set<string>();
    for (const e of ALL_EDGE_CONFIGS) {
      expect(topologiesForEdges(e).length, edgesToString(e)).toBeGreaterThan(0);
      const rots = [0, 1, 2, 3].map((r) => edgesToString([0, 1, 2, 3].map((s) => e[(s + r) & 3]) as unknown as TileEdges));
      classes.add(rots.sort()[0]);
    }
    expect(classes.size).toBe(24);
    const catClasses = new Set([...catalog().values()].map((c) => {
      const e = c.topology.edges;
      return [0, 1, 2, 3].map((r) => edgesToString([0, 1, 2, 3].map((s) => e[(s + r) & 3]) as unknown as TileEdges)).sort()[0];
    }));
    expect(catClasses.size).toBe(24);
  });
  it("every topology passes the structural validator, in every rotation", () => {
    for (const [id, e] of catalog()) {
      expect(validateTopology(e.topology), id).toEqual([]);
      for (let r = 1; r < 4; r++) expect(validateTopology(rotateTopology(e.topology, r))).toEqual([]);
    }
  });
  it("ids are canonical, parseable and rotation-stable", () => {
    for (const [id, e] of catalog()) {
      expect(specId(parseSpecId(id))).toBe(id);
      for (let r = 0; r < 4; r++) expect(canonicalId(rotateSpec(e.spec, r))).toBe(id);
      // rotating the topology gives the same regions as rebuilding the rotated spec
      for (let r = 1; r < 4; r++) {
        const a = rotateTopology(e.topology, r), b = buildTopology(rotateSpec(e.spec, r));
        expect(a.fields.map((f) => [...f.ports].sort().join("")).sort()).toEqual(b.fields.map((f) => f.ports.join("")).sort());
        expect(a.edges).toEqual(b.edges);
      }
    }
  });
  it("classic deck has 72 tiles of 24 kinds present in the catalogue", () => {
    const c = classicComposition();
    expect(c.length).toBe(24);
    expect(new Set(c.map((x) => x.id)).size).toBe(24);
    expect(c.reduce((n, x) => n + x.count, 0)).toBe(72);
    const shields = c.reduce((n, x) => n + x.count * getTopology(x.id).cities.reduce((a, b) => a + b.shields, 0), 0);
    expect(shields).toBe(10);
    expect(c.filter((x) => getTopology(x.id).monastery).reduce((n, x) => n + x.count, 0)).toBe(6);
  });
});

describe("topologies", () => {
  it("through city splits the fields, independent cities leave a through field", () => {
    expect(fieldsOf("CFCF-c02").sort()).toEqual(["23", "67"]);
    expect(fieldsOf("CFCF-c0.2")).toEqual(["2367"]);
    expect(topo("CFCF-c0.2").fields[0].adjacentCityIds).toEqual([0, 1]);
  });
  it("adjacent independent cities keep a corner wedge field", () => {
    const t = topo("CCFF-c0.1");
    expect(t.cities.length).toBe(2);
    expect(t.fields.length).toBe(1);
    expect(t.fields[0].adjacentCityIds).toEqual([0, 1]);
    const u = topo("CCFF-c01");
    expect(u.cities.length).toBe(1);
    expect(u.fields[0].ports).toEqual([4, 5, 6, 7]);
  });
  it("city crossing a through road is impossible", () => {
    const e = [Terrain.CITY, Terrain.ROAD, Terrain.CITY, Terrain.ROAD] as unknown as TileEdges;
    const ids = enumerateSpecs(e).map(specId);
    expect(ids).not.toContain("CRCR-c02-r13");
    expect(ids).not.toContain("CRCR-c02-e13j");
    expect(ids).toContain("CRCR-c0.2-r13");
  });
  it("through road separates fields; village stub lets the field wrap around", () => {
    expect(fieldsOf("RFRF-r02").sort()).toEqual(["0567", "1234"]);
    expect(fieldsOf("FFRF-e2v")).toEqual(["01234567"]);
    expect(fieldsOf("FFRF-e2m-m")).toEqual(["01234567"]);
  });
  it("crossroads: four independent roads, four fields, shared junction", () => {
    const t = topo("RRRR-e0123j");
    expect(t.roads.length).toBe(4);
    expect(t.fields.map((f) => f.ports.join("")).sort()).toEqual(["07", "12", "34", "56"]);
    expect(mainContinuity(t, "road")[0][2]).toBe(false);
    expect(physicalRoadContinuity(t)[0][2]).toBe(true);
    const ids = enumerateSpecs(t.edges).map(specId);
    expect(ids).toContain("RRRR-r01.23");
    expect(ids).toContain("RRRR-r03.12");
    expect(ids).not.toContain("RRRR-r02.13");
    expect(fieldsOf("RRRR-r01.23").sort()).toEqual(["0347", "12", "56"]);
  });
  it("city gates and field adjacency", () => {
    const t = topo("CCRC-c013-e2g0");
    expect(t.terminals[0]).toMatchObject({ kind: "cityGate", cityId: 0 });
    expect(t.fields.map((f) => f.ports.join("")).sort()).toEqual(["4", "5"]);
    expect(t.fields.every((f) => f.adjacentCityIds.join() === "0")).toBe(true);
    const d = topo("CRFR-c0-r13");
    const north = d.fields.find((f) => f.ports.includes(2))!;
    const south = d.fields.find((f) => f.ports.includes(4))!;
    expect(north.ports).toEqual([2, 7]);
    expect(north.adjacentCityIds).toEqual([0]);
    expect(south.adjacentCityIds).toEqual([]);
  });
  it("enclosed port-less fields exist where geometry leaves room", () => {
    const t = topo("CCCC-c0.1.2.3");
    expect(t.fields.length).toBe(1);
    expect(t.fields[0].ports).toEqual([]);
    expect(t.fields[0].adjacentCityIds).toEqual([0, 1, 2, 3]);
    expect(topo("CCCC-c0123").fields.length).toBe(0);
    expect(topo("CCCC-c01.23").fields.length).toBe(1);
  });
  it("continuity matrices derive from partitions", () => {
    const t = topo("CRRF-c0-r12");
    expect(mainContinuity(t, "road")[1][2]).toBe(true);
    expect(fieldContinuity(t)[3][4]).toBe(true);
    expect(fieldContinuity(t)[2][3]).toBe(false);
  });
  it("port matching follows E0<->W1", () => {
    expect(matchingPort(2)).toBe(7);
    expect(matchingPort(3)).toBe(6);
    expect(matchingPort(0)).toBe(5);
    for (let p = 0; p < 8; p++) expect(matchingPort(matchingPort(p))).toBe(p);
  });
});
