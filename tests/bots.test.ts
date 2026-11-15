import { describe, expect, it } from "vitest";
import { createRandom } from "../src/core/random";
import { botSeedKey, chooseTurn, enumerateTurns, fallbackTurn, turnActions } from "../src/ai/bots";
import { playBotGame } from "../src/ai/simulate";
import { determinize, publicView } from "../src/ai/view";
import { applyAction, cloneState, createGame, stateHash, validateAction } from "../src/game/gameEngine";
import { TurnPhase } from "../src/game/state";
import type { BotLevel, GameState } from "../src/game/state";
import { checkInvariants } from "./invariants";
import { config, players } from "./helpers";

const levels: BotLevel[] = ["easy", "normal", "hard", "expert"];
const withLevels = (ls: BotLevel[]) => ls.map((level, i) => ({ id: "p" + i, name: level, color: i, kind: "bot" as const, level }));

function midGame(seed: string, turns: number): GameState {
  return playBotGame(config({ seed, players: withLevels(["normal", "normal"]) }), { maxTurns: turns, create: {} }).state;
}

describe("bots", () => {
  it("every level produces only legal actions and finishes its turns", () => {
    for (const level of levels) {
      let s = createGame(config({ seed: "legal-" + level, players: withLevels([level, level]) }));
      for (let i = 0; i < 12 && s.phase !== TurnPhase.GAME_OVER; i++) {
        const player = s.player;
        const turn = chooseTurn(publicView(s), { level, seedKey: botSeedKey(s), simulations: 24 });
        for (const a of turnActions(turn)) {
          if (s.player !== player || s.phase === TurnPhase.GAME_OVER) break;
          expect(validateAction(s, a), level).toBe("");
          const r = applyAction(s, a);
          if (!r.ok) throw new Error(r.error);
          s = r.state;
        }
        expect(s.player !== player || s.phase === TurnPhase.GAME_OVER).toBe(true);
        expect(checkInvariants(s)).toEqual([]);
      }
    }
  });

  it("decisions never depend on the hidden draw order", () => {
    for (const level of levels) {
      const a = createGame(config({ seed: "hidden", players: withLevels([level, level]) }));
      const b = cloneState(a);
      const rest = b.deck.tiles.slice(b.deck.pos);
      createRandom("other-order").shuffle(rest);
      b.deck = { ...b.deck, tiles: [...b.deck.tiles.slice(0, b.deck.pos), ...rest] };
      expect(b.deck.tiles.map((t) => t.topologyId)).not.toEqual(a.deck.tiles.map((t) => t.topologyId));
      const opts = { level, seedKey: "k", simulations: 30 };
      expect(chooseTurn(publicView(a), opts)).toEqual(chooseTurn(publicView(b), opts));
    }
  });

  it("the public view hides order and seeds of unseen tiles", () => {
    const s = createGame(config({ seed: "view" }));
    const v = publicView(s);
    expect(v.deck.tiles.length).toBe(v.deck.pos);
    expect(v.deck.pool!.length).toBe(s.deck.total - s.deck.pos);
    expect(v.deck.pool!.every((t) => t.seed === 0)).toBe(true);
    const sorted = [...v.deck.pool!].map((t) => t.topologyId).sort();
    expect(v.deck.pool!.map((t) => t.topologyId)).toEqual(sorted);
    expect(v.deck.secret).toBeUndefined();
    const d1 = determinize(v, createRandom("a")), d2 = determinize(v, createRandom("b"));
    expect(d1.deck.tiles.map((t) => t.topologyId)).not.toEqual(d2.deck.tiles.map((t) => t.topologyId));
  });

  it("simulations never modify the real state; same inputs give the same decision", () => {
    const s = midGame("pure", 20);
    const before = stateHash(s);
    const view = publicView(s);
    const viewHash = stateHash(view);
    for (const level of levels) {
      const o = { level, seedKey: "x", simulations: 40 };
      const t1 = chooseTurn(view, o), t2 = chooseTurn(view, o);
      expect(t1).toEqual(t2);
    }
    expect(stateHash(view)).toBe(viewHash);
    expect(stateHash(s)).toBe(before);
    expect(enumerateTurns(view).length).toBeGreaterThan(0);
    expect(validateAction(s, { type: "PLACE_TILE", ...fallbackTurn(view).place })).toBe("");
  });

  it("bot-versus-bot games of every size terminate with consistent states", () => {
    for (let n = 2; n <= 5; n++) {
      const r = playBotGame(config({ seed: "size" + n, players: withLevels(levels.slice(0, 3).concat(["normal", "easy"]).slice(0, n)) }));
      expect(r.state.phase).toBe(TurnPhase.GAME_OVER);
      expect(r.state.tiles.length + r.state.discarded.length).toBe(72);
      expect(checkInvariants(r.state)).toEqual([]);
    }
    const mc = playBotGame(config({ seed: "mc", mode: "procedural", deckSize: 30, players: withLevels(["expert", "hard"]) }), { simulations: 36 });
    expect(mc.state.phase).toBe(TurnPhase.GAME_OVER);
    expect(checkInvariants(mc.state)).toEqual([]);
    void players;
  });

  it("stronger levels obtain measurably better results", () => {
    const duel = (a: BotLevel, b: BotLevel, games: number, sims?: number) => {
      let wa = 0, wb = 0, pa = 0, pb = 0;
      for (let g = 0; g < games; g++) {
        const swap = g % 2 === 1;
        const r = playBotGame(config({ seed: `duel-${a}-${b}-${g}`, players: withLevels(swap ? [b, a] : [a, b]) }), { simulations: sims });
        const sa = r.state.players[swap ? 1 : 0].score, sb = r.state.players[swap ? 0 : 1].score;
        pa += sa; pb += sb;
        if (sa > sb) wa++; else if (sb > sa) wb++;
      }
      console.log(`${a} vs ${b}: ${wa}-${wb} over ${games} games, mean ${(pa / games).toFixed(1)} / ${(pb / games).toFixed(1)}`);
      return { wa, wb, pa, pb };
    };
    const g1 = duel("normal", "easy", 30);
    expect(g1.wa).toBeGreaterThan(g1.wb * 2);
    const g2 = duel("hard", "normal", 30);
    expect(g2.wa).toBeGreaterThan(g2.wb);
    expect(g2.pa).toBeGreaterThan(g2.pb);
    const g3 = duel("expert", "normal", 8, 60);
    expect(g3.pa).toBeGreaterThan(g3.pb);
  });
});
