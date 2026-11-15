import { describe, expect, it } from "vitest";
import { canonicalJson, murmur3, sha256 } from "../src/core/hash";
import { createRandom, randomSeedString } from "../src/core/random";
import { playBotGame } from "../src/ai/simulate";
import { buildDeck, classicDeck, proceduralDeck, sandboxTile, topologyWeights } from "../src/game/deck";
import { applyAction, createGame, stateHash } from "../src/game/gameEngine";
import { DEFAULT_DECK_PARAMS } from "../src/game/state";
import { catalog, classicComposition, getEntry } from "../src/procedural/topology/catalog";
import { generateGeometry, geometrySeedOf, visualSeedOf } from "../src/procedural/geometry/tileGeometry";
import { ReplayPlayer } from "../src/persistence/replay";
import { SaveError, loadSave, parseSave, replay, serializeSave, toSave } from "../src/persistence/serialization";
import type { Recording } from "../src/persistence/serialization";
import { config } from "./helpers";

const bots = (n = 2) => Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "B" + i, color: i, kind: "bot" as const, level: "normal" as const }));

describe("hashing and PRNG", () => {
  it("sha256 matches the FIPS test vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256("é€😀")).toBe(sha256(new TextEncoder().encode("é€😀")));
  });
  it("murmur3 matches reference values", () => {
    expect(murmur3("", 0)).toBe(0);
    expect(murmur3("", 1)).toBe(0x514e28b7);
  });
  it("canonical JSON sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  it("same key gives the same stream; forks are independent of consumption", () => {
    const a = createRandom("k"), b = createRandom("k");
    const xs = Array.from({ length: 8 }, () => a.nextUint32());
    expect(Array.from({ length: 8 }, () => b.nextUint32())).toEqual(xs);
    const c = createRandom("k");
    const f1 = c.fork("x").nextUint32();
    for (let i = 0; i < 100; i++) c.nextUint32();
    expect(c.fork("x").nextUint32()).toBe(f1);
    expect(createRandom("k").fork("y").nextUint32()).not.toBe(f1);
    expect(randomSeedString()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSeedString()).not.toBe(randomSeedString());
  });
  it("nextInt is unbiased on an awkward range (chi-square) and respects bounds", () => {
    const r = createRandom("chi");
    const k = 6, n = 60000, counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) { const v = r.nextInt(10, 10 + k - 1); expect(v >= 10 && v < 10 + k).toBe(true); counts[v - 10]++; }
    const chi = counts.reduce((s, c) => s + (c - n / k) ** 2 / (n / k), 0);
    expect(chi).toBeLessThan(20.5); // df = 5, p ~ 0.001
    expect(() => r.nextInt(3, 2)).toThrow();
    expect(r.nextInt(7, 7)).toBe(7);
  });
  it("floats are uniform in [0,1) (mean, variance, 10-bin chi-square)", () => {
    const r = createRandom("float");
    const n = 100000, bins = new Array(10).fill(0);
    let sum = 0, sq = 0;
    for (let i = 0; i < n; i++) { const v = r.nextFloat(); expect(v >= 0 && v < 1).toBe(true); sum += v; sq += v * v; bins[Math.floor(v * 10)]++; }
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.005);
    expect(Math.abs(sq / n - 1 / 3)).toBeLessThan(0.005);
    expect(bins.reduce((s, c) => s + (c - n / 10) ** 2 / (n / 10), 0)).toBeLessThan(27.9); // df = 9, p ~ 0.001
  });
  it("Fisher-Yates produces every permutation of 4 items evenly", () => {
    const r = createRandom("perm");
    const counts = new Map<string, number>();
    const n = 48000;
    for (let i = 0; i < n; i++) { const k = r.shuffle([0, 1, 2, 3]).join(""); counts.set(k, (counts.get(k) ?? 0) + 1); }
    expect(counts.size).toBe(24);
    const chi = [...counts.values()].reduce((s, c) => s + (c - n / 24) ** 2 / (n / 24), 0);
    expect(chi).toBeLessThan(49.7); // df = 23, p ~ 0.001
  });
  it("weightedChoice follows the weights", () => {
    const r = createRandom("w");
    const c = [0, 0, 0];
    for (let i = 0; i < 30000; i++) c[r.weightedChoice([0, 1, 2], [1, 2, 7])]++;
    expect(Math.abs(c[0] / 30000 - 0.1)).toBeLessThan(0.01);
    expect(Math.abs(c[2] / 30000 - 0.7)).toBeLessThan(0.015);
    expect(() => r.weightedChoice([1], [0])).toThrow();
  });
});

describe("decks", () => {
  it("same seed, same deck; different seed, different order", () => {
    const a = classicDeck("s1"), b = classicDeck("s1"), c = classicDeck("s2");
    expect(a).toEqual(b);
    expect(a.map((t) => t.topologyId)).not.toEqual(c.map((t) => t.topologyId));
    expect(proceduralDeck("s1", 80, DEFAULT_DECK_PARAMS)).toEqual(proceduralDeck("s1", 80, DEFAULT_DECK_PARAMS));
    expect(sandboxTile("s", 17, DEFAULT_DECK_PARAMS)).toEqual(sandboxTile("s", 17, DEFAULT_DECK_PARAMS));
  });
  it("classic deck keeps its exact composition whatever the seed", () => {
    const want = new Map(classicComposition().map((c) => [c.id, c.count]));
    for (const seed of ["a", "b", "c"]) {
      const deck = classicDeck(seed);
      expect(deck.length).toBe(72);
      const got = new Map<string, number>();
      for (const t of deck) got.set(t.topologyId, (got.get(t.topologyId) ?? 0) + 1);
      expect(got).toEqual(want);
      expect(deck[0].topologyId).toBe(classicComposition().find((c) => c.letter === "D")!.id);
    }
  });
  it("shuffle positions are uniform: each classic kind appears evenly across draw positions", () => {
    const pos = new Array(71).fill(0);
    const monastery = classicComposition().find((c) => c.letter === "B")!.id;
    const n = 3000;
    for (let i = 0; i < n; i++) classicDeck("u" + i).forEach((t, k) => { if (k > 0 && t.topologyId === monastery) pos[k - 1]++; });
    const expected = (n * 4) / 71;
    const chi = pos.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(120); // df = 70, p ~ 0.0002
  });
  it("procedural decks are varied, balanced and respond to parameters", () => {
    const stats = (deck: { topologyId: string }[]) => {
      const s = { city: 0, road: 0, grass: 0, shields: 0, monastery: 0, kinds: new Set<string>() };
      for (const t of deck) { const st = getEntry(t.topologyId).stats; s.city += st.citySides; s.road += st.roadSides; s.grass += st.grassSides; s.shields += st.shields; s.monastery += st.monastery ? 1 : 0; s.kinds.add(t.topologyId); }
      return s;
    };
    const base = stats(proceduralDeck("p", 120, DEFAULT_DECK_PARAMS));
    expect(base.kinds.size).toBeGreaterThan(30);
    expect(base.grass / 480).toBeGreaterThan(0.3);
    expect(base.city / 480).toBeGreaterThan(0.12);
    expect(base.road / 480).toBeGreaterThan(0.15);
    expect(base.monastery).toBeGreaterThan(2);
    const urban = stats(proceduralDeck("p", 120, { ...DEFAULT_DECK_PARAMS, cityDensity: 2 }));
    expect(urban.city).toBeGreaterThan(base.city * 1.3);
    const holy = stats(proceduralDeck("p", 120, { ...DEFAULT_DECK_PARAMS, monasteryFreq: 3 }));
    expect(holy.monastery).toBeGreaterThan(base.monastery);
    const noShield = stats(proceduralDeck("p", 120, { ...DEFAULT_DECK_PARAMS, shieldFreq: 0 }));
    expect(noShield.shields).toBe(0);
    const w = topologyWeights(DEFAULT_DECK_PARAMS);
    expect(w.weights.every((x) => x > 0 && Number.isFinite(x))).toBe(true);
    expect(w.ids.length).toBe(catalog().size);
    expect(buildDeck(config({ mode: "procedural", deckSize: 50 }), "x").length).toBe(50);
  });
  it("rotations offered to players are evenly usable; unplaceable tiles are rare in classic games", () => {
    let discarded = 0, tiles = 0;
    const rot = [0, 0, 0, 0];
    for (let g = 0; g < 40; g++) {
      const r = playBotGame(config({ seed: "st" + g, players: bots() }));
      discarded += r.state.discarded.length;
      tiles += r.state.tiles.length;
      for (const t of r.state.tiles.slice(1)) if (getEntry(t.def.topologyId).symmetry === 4) rot[t.rotation]++;
    }
    console.log(`classic: ${discarded} discarded of ${tiles + discarded} tiles; rotations of asymmetric tiles ${rot.join("/")}`);
    expect(discarded / (tiles + discarded)).toBeLessThan(0.02);
    expect(Math.min(...rot)).toBeGreaterThan(0.1 * rot.reduce((a, b) => a + b, 0));
  });
});

describe("determinism, saves and replays", () => {
  it("same state and action give the same new state; same history gives the same scores", () => {
    const s = createGame(config({ seed: "det" }));
    const a = { type: "PLACE_TILE" as const, ...{ x: 0, y: 1, rotation: 0 } };
    const r1 = applyAction(s, a), r2 = applyAction(s, a);
    if (r1.ok && r2.ok) expect(stateHash(r1.state)).toBe(stateHash(r2.state));
    const g1 = playBotGame(config({ seed: "same", players: bots(3) }));
    const g2 = playBotGame(config({ seed: "same", players: bots(3) }));
    expect(g1.actions).toEqual(g2.actions);
    expect(stateHash(g1.state)).toBe(stateHash(g2.state));
    expect(stateHash(playBotGame(config({ seed: "other", players: bots(3) })).state)).not.toBe(stateHash(g1.state));
  });
  it("tile seeds: geometry and visual domains are independent and order-free", () => {
    expect(geometrySeedOf(5)).not.toBe(visualSeedOf(5));
    expect(geometrySeedOf(5)).toBe(geometrySeedOf(5));
    const id = classicComposition()[9].id;
    const a = generateGeometry(id, geometrySeedOf(77));
    for (const c of classicComposition()) generateGeometry(c.id, 3);
    const b = generateGeometry(id, geometrySeedOf(77));
    expect(b.shapes).toEqual(a.shapes);
  });
  it("a full game survives save -> text -> load, and replays action by action", () => {
    const cfg = config({ seed: "save", mode: "procedural", deckSize: 40, players: bots(3) });
    const deck = buildDeck(cfg, cfg.seed);
    const sim = playBotGame(cfg, { create: { tiles: deck } });
    // Rebuild the per-player action list from the engine.
    let st = createGame(cfg, { tiles: deck });
    const actions: Recording["actions"] = [];
    for (const a of sim.actions) { actions.push([st.player, a]); const r = applyAction(st, a); if (!r.ok) throw new Error(r.error); st = r.state; }
    const rec: Recording = { config: cfg, deck, total: deck.length, actions };
    const text = serializeSave(toSave(rec, sim.state, "test", "2026-01-01T00:00:00Z"));
    expect(text.length).toBeLessThan(12000);
    expect(text).not.toMatch(/data:image|png|base64/i);
    const loaded = loadSave(parseSave(text));
    expect(stateHash(loaded.state)).toBe(stateHash(sim.state));
    expect(loaded.state.players.map((p) => p.score)).toEqual(sim.state.players.map((p) => p.score));
    expect(serializeSave(toSave(loaded.rec, loaded.state, "test", "2026-01-01T00:00:00Z"))).toBe(text); // canonical
    const player = new ReplayPlayer(loaded.rec);
    const mid = Math.floor(player.length / 2);
    const h = stateHash(player.seek(mid));
    player.seek(player.length);
    expect(stateHash(player.current)).toBe(stateHash(sim.state));
    expect(stateHash(player.seek(mid))).toBe(h);
    expect(stateHash(player.step(-1))).toBe(stateHash(replay(loaded.rec, mid - 1)));
    console.log(`save size for a ${deck.length}-tile, 3-player game: ${text.length} bytes`);
  });
  it("partial games and sandbox games reload and continue identically", () => {
    const cfg = config({ seed: "sand", mode: "sandbox", players: bots() });
    let st = createGame(cfg);
    const actions: Recording["actions"] = [];
    const sim = playBotGame(cfg, { maxTurns: 25 });
    for (const a of sim.actions.slice(0, 30)) { actions.push([st.player, a]); const r = applyAction(st, a); if (!r.ok) throw new Error(r.error); st = r.state; }
    const rec: Recording = { config: cfg, deck: [], total: -1, secret: cfg.seed, actions };
    const save = toSave(rec, st, "sandbox", "t");
    const loaded = loadSave(parseSave(serializeSave(save)));
    expect(stateHash(loaded.state)).toBe(stateHash(st));
    expect(loaded.state.current).toEqual(st.current);
  });
  it("corrupted, foreign, tampered or too-recent saves are rejected with a clear error", () => {
    const cfg = config({ seed: "bad", players: bots() });
    const deck = buildDeck(cfg, cfg.seed);
    const st = createGame(cfg, { tiles: deck });
    const save = toSave({ config: cfg, deck, total: deck.length, actions: [] }, st, "n", "t");
    expect(() => parseSave("{not json")).toThrow(SaveError);
    expect(() => parseSave("[]")).toThrow(SaveError);
    expect(() => parseSave(JSON.stringify({ ...save, format: 99 }))).toThrow(/plus récent/);
    expect(() => parseSave(JSON.stringify({ ...save, generator: 0 }))).toThrow(/générateur/);
    expect(() => parseSave(JSON.stringify({ ...save, app: "x" }))).toThrow(SaveError);
    expect(() => parseSave(JSON.stringify({ ...save, deck: [["<script>", 1]] }))).toThrow(/inconnue/);
    expect(() => loadSave(parseSave(JSON.stringify({ ...save, actions: [[0, { type: "PLACE_TILE", x: 9, y: 9, rotation: 0 }]] })))).toThrow(/incohérent/);
    expect(() => loadSave(parseSave(JSON.stringify({ ...save, hash: "00" })))).toThrow(/empreinte/);
    // An old (format 0) save is migrated.
    const old = { ...save, format: 0, history: save.actions } as Record<string, unknown>;
    delete old.actions; delete old.total;
    expect(loadSave(parseSave(JSON.stringify(old))).state.tiles.length).toBe(1);
  });
});
