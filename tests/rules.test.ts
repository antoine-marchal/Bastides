import { describe, expect, it } from "vitest";
import { cellKey } from "../src/core/coordinates";
import { applyAction, canPlace, cloneState, createGame, inspectRegion, legalPlacements, meepleOptions, ranking, regionOf, stateHash, tilesRemaining, validateAction } from "../src/game/gameEngine";
import { TurnPhase } from "../src/game/state";
import { config, featureOf, oriented, playStep, players, scripted } from "./helpers";

const N = 0, E = 1, S = 2, W = 3;
const deck = (...raw: string[]) => ({ tiles: [oriented("CRFR-c0-r13").def, ...raw.map((x) => oriented(x).def)] });

describe("scoring scenarios", () => {
  it("completed road over five tiles scores 5 for a non-active owner", () => {
    const s = scripted([
      { raw: "FRFR-r13", x: 1, y: 0, claim: { road: E } }, // p0
      { raw: "FRFR-r13", x: 2, y: 0 }, // p1
      { raw: "FRFF-e1m-m", x: -1, y: 0 }, // p0 closes the west end
      { raw: "FFRR-e23j", x: 3, y: 0 }, // p1 closes the east end
      { raw: "FFFF-m", x: 0, y: 1 },
    ]);
    const ev = s.log.find((e) => e.featureType === "road" && !e.final)!;
    expect(ev.points).toBe(5);
    expect(ev.tileCount).toBe(5);
    expect(ev.winningPlayerIds).toEqual(["p0"]);
    expect(ev.turn).toBe(3); // scored during the turn of p1
    expect(s.players[0].score).toBe(5);
    expect(s.players[0].meeples).toBe(7);
  });

  it("completed city, 4 tiles and 2 shields: 12 points; two tied owners get 12 each", () => {
    const s = scripted([
      { raw: "FCCF-c12s", x: 0, y: -1, claim: { city: S } }, // p0
      { raw: "CFFR-c0-e3v", x: 1, y: 0, claim: { city: N } }, // p1, separate city
      { raw: "FFCC-c23s", x: 1, y: -1 }, // p0 merges and closes
      { raw: "FFFF-m", x: 0, y: 1 },
    ]);
    const ev = s.log.find((e) => e.featureType === "city")!;
    expect(ev).toMatchObject({ points: 12, tileCount: 4, shieldCount: 2, final: false });
    expect([...ev.winningPlayerIds].sort()).toEqual(["p0", "p1"]);
    expect(s.players.map((p) => p.score)).toEqual([12, 12]);
    expect(s.players.map((p) => p.meeples)).toEqual([7, 7]);
    expect(s.log.filter((e) => e.featureType === "city").length).toBe(1); // no double scoring
  });

  it("the same city left incomplete scores 6 at the end", () => {
    const s = scripted([
      { raw: "CFCF-c02s", x: 0, y: -1, claim: { city: N } },
      { raw: "CFCF-c02s", x: 0, y: -2 },
      { raw: "CFCF-c02", x: 0, y: -3 },
    ]);
    expect(s.phase).toBe(TurnPhase.GAME_OVER);
    const ev = s.log.find((e) => e.featureType === "city")!;
    expect(ev).toMatchObject({ points: 6, tileCount: 4, shieldCount: 2, final: true });
    expect(s.players[0].final).toBe(6);
    expect(s.players[0].duringGame).toBe(0);
  });

  const ring = [
    { raw: "FRFF-e1v", x: -1, y: 0 }, { raw: "FFFR-e3v", x: 1, y: 0 },
    { raw: "FFFF-m", x: -1, y: 1 }, { raw: "FFFF-m", x: 1, y: 1 },
    { raw: "FFFF-m", x: -1, y: 2 }, { raw: "FFFF-m", x: 0, y: 2 }, { raw: "FFFF-m", x: 1, y: 2 },
  ];
  it("monastery fully surrounded scores 9", () => {
    const s = scripted([{ raw: "FFFF-m", x: 0, y: 1, claim: "monastery" }, ...ring, { raw: "FFFF-m", x: 0, y: 3 }]);
    const ev = s.log.find((e) => e.featureType === "monastery")!;
    expect(ev).toMatchObject({ points: 9, final: false });
    expect(s.players[0].score).toBe(9);
    expect(s.players[0].meeples).toBe(7);
  });
  it("monastery with five neighbours scores 6 at the end", () => {
    const s = scripted([{ raw: "FFFF-m", x: 0, y: 1, claim: "monastery" }, ...ring.slice(0, 4)]);
    const ev = s.log.find((e) => e.featureType === "monastery")!;
    expect(ev).toMatchObject({ points: 6, final: true });
  });

  it("field next to three distinct completed cities scores 9; a city touching the field twice counts once", () => {
    const s = scripted([
      { raw: "FFCF-c2", x: 0, y: -1, claim: { field: 0 } }, // p0 farmer, closes city 1
      { raw: "FCFF-c1", x: 1, y: -1 },
      { raw: "FFFC-c3", x: 2, y: -1 }, // city 2 closed
      { raw: "FFFC-c3", x: -1, y: -1 },
      { raw: "FCFF-c1", x: -2, y: -1 }, // city 3 closed
      { raw: "FFFR-e3v", x: 1, y: 0 }, // links the north field of the start tile: city 1 touches twice
      { raw: "CFFF-c0", x: 0, y: -2 }, // an unfinished city gives nothing to farmers
    ]);
    expect(s.phase).toBe(TurnPhase.GAME_OVER);
    const ev = s.log.find((e) => e.featureType === "field")!;
    expect(ev).toMatchObject({ points: 9, final: true });
    expect(ev.winningPlayerIds).toEqual(["p0"]);
    const info = inspectRegion(s, 1, featureOf(s, { field: 0 }, 1));
    expect(info.adjacentCities.filter((c) => c.closed).length).toBe(3);
    expect(info.adjacentCities.length).toBe(4);
    expect(info.tiles).toContain(0);
  });

  it("minority gets nothing but every meeple returns; scores go to non-active players", () => {
    const s = scripted([
      { raw: "FCCF-c1.2", x: 0, y: -1, claim: { city: E } }, // p0
      { raw: "CFFR-c0-e3v", x: 1, y: 0, claim: { city: N } }, // p1
      { raw: "FFFF-m", x: 0, y: -2 }, // p0
      { raw: "FRFF-e1v", x: -1, y: 0 }, // p1
      { raw: "FFCF-c2", x: 1, y: -2, claim: { city: S } }, // p0, second meeple
      { raw: "CFCC-c023", x: 1, y: -1 }, // p1 merges the three and closes
      { raw: "FFFF-m", x: 0, y: 1 },
    ]);
    const ev = s.log.find((e) => e.featureType === "city" && e.points === 8)!;
    expect(ev.winningPlayerIds).toEqual(["p0"]);
    expect(ev.meeples).toEqual([2, 1]);
    expect(s.players.map((p) => p.score)).toEqual([8, 0]);
    expect(s.players.map((p) => p.meeples)).toEqual([7, 7]);
  });

  it("a tile present twice in one city is counted once", () => {
    const loop = scripted([
      { raw: "CCCF-c012", x: 0, y: -1, claim: { city: N } },
      { raw: "FCCF-c1.2", x: 0, y: -2 }, // two segments of the same future city
      { raw: "CFFC-c03", x: 1, y: -1 },
      { raw: "FFCC-c23", x: 1, y: -2 }, // closes the loop
      { raw: "FFFF-m", x: 0, y: 1 },
    ]);
    const c = loop.log.find((e) => e.featureType === "city")!;
    expect(c.tileCount).toBe(5);
    expect(c.points).toBe(10);
    expect(c.final).toBe(false);
  });

  it("several features completed in the same game are each scored once", () => {
    const s = scripted([
      { raw: "FRFF-e1v", x: -1, y: 0, claim: { road: E } }, // p0: west end
      { raw: "FFCF-c2", x: 0, y: -1, claim: { city: S } }, // p1: closes the start city at once (4 pts)
      { raw: "FFFR-e3v", x: 1, y: 0 }, // p0: closes the road (3 tiles)
      { raw: "FFFF-m", x: 0, y: 1 },
    ]);
    expect(s.players.map((p) => p.score)).toEqual([3, 4]);
    expect(s.log.length).toBe(2);
  });

  it("one tile can complete a road and a city simultaneously", () => {
    // (0,-1) closes the start city AND, being a road end, closes the road coming from (1,-1).
    const s = scripted([
      { raw: "FFRR-r23", x: 1, y: 0, claim: { road: W } }, // p0: start road now goes east then south... open
      { raw: "FRFF-e1v", x: -1, y: 0 }, // p1: west end closed
      { raw: "RFFF-e0v", x: 1, y: 1 }, // p0: closes the road: start, (1,0), (-1,0), (1,1) = 4 tiles
      { raw: "FFCF-c2", x: 0, y: -1, claim: { city: S } }, // p1: 4 points
      { raw: "FFFF-m", x: 0, y: 1 },
    ]);
    expect(s.players.map((p) => p.score)).toEqual([4, 4]);
  });

  it("a road ring is complete with zero open ends", () => {
    const s = scripted([
      { raw: "FFFR-e3v", x: 1, y: 0 },
      { raw: "FRRF-r12", x: 1, y: 1, claim: { road: E } },
      { raw: "FFRR-r23", x: 2, y: 1 },
      { raw: "RRFF-r01", x: 1, y: 2 },
      { raw: "RFFR-r03", x: 2, y: 2 },
      { raw: "FFFF-m", x: 0, y: 1 },
    ]);
    const ev = s.log.find((e) => e.featureType === "road" && !e.final)!;
    expect(ev).toMatchObject({ points: 4, tileCount: 4 });
  });
});

describe("rules", () => {
  it("placement must touch a tile by an edge and match every edge", () => {
    const s = createGame(config(), deck("FFFF-m", "CCCC-c0123s"));
    const d = s.current!;
    expect(canPlace(s, d, 0, 1, 0)).toBe(true); // south of the start tile is grass
    expect(canPlace(s, d, 0, -1, 0)).toBe(false); // city edge mismatch
    expect(canPlace(s, d, 1, 1, 0)).toBe(false); // diagonal only
    expect(canPlace(s, d, 0, 0, 0)).toBe(false); // occupied
    expect(legalPlacements(s).map((p) => `${p.x},${p.y}`)).toEqual(["0,1"]);
    expect(validateAction(s, { type: "PLACE_TILE", x: 5, y: 5, rotation: 0 })).not.toBe("");
    expect(validateAction(s, { type: "SKIP_MEEPLE" })).not.toBe("");
    expect(validateAction(s, { type: "PLACE_TILE", x: 0, y: 1, rotation: 0 }, 1)).toContain("tour");
    expect(validateAction(s, { type: "PLACE_TILE", x: 0, y: 1.5, rotation: 0 })).not.toBe("");
    expect(validateAction(s, { type: "HACK" } as never)).not.toBe("");
    expect(validateAction(s, { type: "END_GAME" })).not.toBe("");
  });

  it("rotations are deduplicated by symmetry and all orientations are usable", () => {
    const s = createGame(config(), deck("CFFF-c0", "FFFF-m"));
    expect(legalPlacements(s).filter((p) => p.x === 0 && p.y === -1).length).toBe(1);
    expect(legalPlacements(s).filter((p) => p.x === 0 && p.y === 1).length).toBe(3);
  });

  it("turn order, phases and purity of the reducer", () => {
    let s = createGame(config({ players: players(3) }), deck("FFFF-m", "FFFF-m", "FFFF-m", "FFFF-m", "FFFF-m", "FFFF-m"));
    expect(s.phase).toBe(TurnPhase.PLACE_TILE);
    const before = stateHash(s);
    const r = applyAction(s, { type: "PLACE_TILE", x: 0, y: 1, rotation: 0 });
    expect(r.ok).toBe(true);
    expect(stateHash(s)).toBe(before); // input untouched
    if (!r.ok) return;
    expect(r.state.phase).toBe(TurnPhase.PLACE_MEEPLE);
    expect(r.state.player).toBe(0);
    const r2 = applyAction(r.state, { type: "SKIP_MEEPLE" });
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.state.player).toBe(1);
    expect(r2.state.turn).toBe(1);
    expect(tilesRemaining(r2.state)).toBe(4);
    s = playStep(r2.state, { raw: "FFFF-m", x: 0, y: 2 });
    expect(s.player).toBe(2);
    s = playStep(s, { raw: "FFFF-m", x: 0, y: 3 });
    expect(s.player).toBe(0);
  });

  it("cannot claim an occupied region, but occupied regions may merge later", () => {
    let s = createGame(config(), deck("FRFR-r13", "FRFR-r13", "FFFF-m"));
    s = playStep(s, { raw: "FRFR-r13", x: 1, y: 0, claim: { road: E } });
    const r = applyAction(s, { type: "PLACE_TILE", x: 2, y: 0, rotation: oriented("FRFR-r13").rotation });
    if (!r.ok) throw new Error(r.error);
    const opts = meepleOptions(r.state);
    const road = opts.find((o) => o.kind === "road")!;
    expect(road).toMatchObject({ allowed: false, reason: "occupied" });
    expect(applyAction(r.state, { type: "PLACE_MEEPLE", regionId: road.regionId }).ok).toBe(false);
    expect(opts.filter((o) => o.kind === "field").every((o) => o.allowed)).toBe(true);
    // Two independently claimed cities merged by a later tile hold two meeples (see tie scenario).
  });

  it("farmers can be disabled; a player without meeples skips automatically", () => {
    let s = createGame(config({ farmers: false }), deck("FFFF-m", "FFFF-m"));
    const r = applyAction(s, { type: "PLACE_TILE", x: 0, y: 1, rotation: 0 });
    if (!r.ok) throw new Error(r.error);
    expect(meepleOptions(r.state).find((o) => o.kind === "field")).toMatchObject({ allowed: false, reason: "farmers-disabled" });
    s = cloneState(createGame(config(), deck("FFFF-m", "FFFF-m")));
    s.players[0].meeples = 0;
    const r2 = applyAction(s, { type: "PLACE_TILE", x: 0, y: 1, rotation: 0 });
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.state.player).toBe(1); // meeple phase skipped
  });

  it("an unplaceable tile is discarded and the next one is drawn", () => {
    let s = createGame(config(), deck("FFFF-m", "FFFF-m", "CFFF-c0", "FFFF-m"));
    const r = applyAction(s, { type: "PLACE_TILE", x: 0, y: 1, rotation: 0 });
    if (!r.ok) throw new Error(r.error);
    s = cloneState(r.state);
    s.frontier = new Set([cellKey(0, -1)]); // only a city-facing slot remains
    const r2 = applyAction(s, { type: "SKIP_MEEPLE" });
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.state.discarded.length).toBe(1);
    expect(r2.state.current!.topologyId).toBe(oriented("CFFF-c0").def.topologyId);
    expect(tilesRemaining(r2.state)).toBe(1);
  });

  it("ranking keeps ties", () => {
    const s = scripted([
      { raw: "FCCF-c12s", x: 0, y: -1, claim: { city: S } },
      { raw: "CFFR-c0-e3v", x: 1, y: 0, claim: { city: N } },
      { raw: "FFCC-c23s", x: 1, y: -1 },
    ]);
    expect(ranking(s).map((r) => r.rank)).toEqual([1, 1]);
    expect(regionOf(s, s.tiles[0].base).open).toBe(0);
  });

  it("sandbox draws endlessly and ends on END_GAME", () => {
    let s = createGame(config({ mode: "sandbox", seed: "sb" }));
    expect(tilesRemaining(s)).toBe(-1);
    for (let i = 0; i < 30; i++) {
      const p = legalPlacements(s)[0];
      let r = applyAction(s, { type: "PLACE_TILE", ...p });
      if (!r.ok) throw new Error(r.error);
      s = r.state;
      if (s.phase === TurnPhase.PLACE_MEEPLE) { r = applyAction(s, { type: "SKIP_MEEPLE" }); if (!r.ok) throw new Error(r.error); s = r.state; }
    }
    expect(s.tiles.length).toBe(31);
    const end = applyAction(s, { type: "END_GAME" });
    expect(end.ok && end.state.phase === TurnPhase.GAME_OVER).toBe(true);
    void W;
  });
});
