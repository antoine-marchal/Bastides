import { describe, expect, it } from "vitest";
import { Terrain, TILE_SIZE } from "../src/core/types";
import { catalog, getTopology, canonicalId } from "../src/procedural/topology/catalog";
import { MAX_ATTEMPTS, generateGeometry, tryGeometry, featureAt, featureIndex } from "../src/procedural/geometry/tileGeometry";
import { K_CITY, K_FIELD, K_ROAD, rasterize, components } from "../src/procedural/geometry/masks";
import { validateMask, borderPixel } from "../src/procedural/geometry/validator";

const SEEDS = [1, 2, 3, 7, 42, 1234, 99991, 0xdeadbeef];

describe("geometry", () => {
  it("every topology gets a validated geometry for several seeds; fallback always works", () => {
    const ids = [...catalog().keys()];
    let fallbacks = 0, total = 0, firstTry = 0;
    const failing: string[] = [];
    for (const id of ids) {
      const t = getTopology(id);
      const calm = tryGeometry(t, 0, MAX_ATTEMPTS);
      if (!calm.geometry) failing.push(id + " [calm] " + calm.errors[0]);
      for (const seed of SEEDS) {
        total++;
        try {
          const g = generateGeometry(id, seed);
          if (g.attempt === MAX_ATTEMPTS) fallbacks++;
          if (g.attempt === 0) firstTry++;
        } catch (e) { failing.push((e as Error).message); }
      }
    }
    console.log(`topologies=${ids.length} geometries=${total} firstTry=${firstTry} fallbacks=${fallbacks}`);
    expect(failing).toEqual([]);
    expect(firstTry / total).toBeGreaterThan(0.8);
  });

  it("logic and geometry agree at a higher validation resolution", () => {
    for (const id of catalog().keys()) {
      const g = generateGeometry(id, 42);
      const v = validateMask(getTopology(id), rasterize(g.shapes, 256));
      expect(v.errors, id).toEqual([]);
    }
  });

  it("is deterministic and independent from generation order", () => {
    const a = generateGeometry(canonicalId("CRFR-c0-r13"), 5);
    generateGeometry(canonicalId("RRRR-e0123j"), 9);
    const b = tryGeometry(getTopology(a.topologyId), 5, a.attempt).geometry!;
    expect(Array.from(b.mask.kind)).toEqual(Array.from(a.mask.kind));
    expect(b.anchors).toEqual(a.anchors);
    const c = generateGeometry(a.topologyId, 6);
    expect(Array.from(c.mask.kind)).not.toEqual(Array.from(a.mask.kind));
  });

  it("road profile: 16 px wide, centred on 64, perpendicular; city spans the useful length", () => {
    for (const id of catalog().keys()) {
      const t = getTopology(id), g = generateGeometry(id, 3);
      for (let s = 0; s < 4; s++) {
        const row = Array.from({ length: TILE_SIZE }, (_, k) => g.mask.kind[borderPixel(TILE_SIZE, s, k)]);
        if (t.edges[s] === Terrain.ROAD) {
          const idx = row.map((v, k) => (v === K_ROAD ? k : -1)).filter((k) => k >= 0);
          expect(idx.length, id).toBeGreaterThanOrEqual(15);
          expect(idx.length, id).toBeLessThanOrEqual(17);
          expect(Math.abs((idx[0] + idx[idx.length - 1] + 1) / 2 - 64), id).toBeLessThanOrEqual(1);
          const path = g.shapes.roads.find((r) => r.id === t.roads.find((x) => x.sides.includes(s as 0))!.id)!.path;
          const end = t.roads.find((x) => x.sides.includes(s as 0))!.sides[0] === s ? [path[0], path[1]] : [path[path.length - 1], path[path.length - 2]];
          const dx = end[1].x - end[0].x, dy = end[1].y - end[0].y;
          const along = s % 2 === 0 ? Math.abs(dx) : Math.abs(dy);
          expect(along / Math.hypot(dx, dy), id).toBeLessThan(0.12);
        } else if (t.edges[s] === Terrain.CITY) {
          expect(row.slice(7, 121).every((v) => v === K_CITY), id).toBe(true);
        } else expect(row.slice(7, 121).every((v) => v === K_FIELD), id).toBe(true);
      }
    }
  });

  it("corner contacts never merge independent cities", () => {
    const g = generateGeometry(canonicalId("CCFF-c0.1"), 11);
    const { comps } = components(g.mask);
    expect(comps.filter((c) => c.kind === K_CITY).length).toBe(2);
    expect(comps.filter((c) => c.kind === K_FIELD).length).toBe(1);
  });

  it("the validator rejects a geometry whose topology differs", () => {
    const g = generateGeometry(canonicalId("CFCF-c02"), 4);
    const wrong = getTopology(canonicalId("CFCF-c0.2"));
    expect(validateMask(wrong, rasterize(g.shapes, 128)).ok).toBe(false);
    const road = generateGeometry(canonicalId("RFRF-r02"), 4);
    expect(validateMask(getTopology(canonicalId("RFRF-e02j")), rasterize(road.shapes, 128)).ok).toBe(false);
  });

  it("anchors lie on their own feature, in every rotation", () => {
    for (const id of catalog().keys()) {
      const t = getTopology(id), g = generateGeometry(id, 8);
      const n = t.cities.length + t.roads.length + t.fields.length + (t.monastery ? 1 : 0);
      expect(g.anchors.length).toBe(n);
      for (let f = 0; f < n; f++) {
        expect(featureAt(g, 0, g.anchors[f].x, g.anchors[f].y), id + " f" + f).toBe(f);
      }
      expect(featureIndex(t, "field", 0)).toBe(t.cities.length + t.roads.length);
    }
  });
});
