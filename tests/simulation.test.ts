import { describe, expect, it } from "vitest";
import { createRandom } from "../src/core/random";
import { playBotGame } from "../src/ai/simulate";
import { applyAction, createGame, legalPlacements, meepleOptions, stateHash } from "../src/game/gameEngine";
import { DEFAULT_DECK_PARAMS, TurnPhase } from "../src/game/state";
import type { BotLevel, GameMode } from "../src/game/state";
import { checkInvariants } from "./invariants";
import { config } from "./helpers";

const bots = (levels: BotLevel[]) => levels.map((level, i) => ({ id: "p" + i, name: level + i, color: i, kind: "bot" as const, level }));

describe("mass simulation (headless bot versus bot)", () => {
  it("3000 games terminate without rule inconsistency, deadlock or imbalance", () => {
    const t0 = Date.now();
    let games = 0, tiles = 0, discarded = 0, firstWins = 0, decided = 0;
    const scoreSum = [0, 0];
    const run = (n: number, mode: GameMode, levels: BotLevel[], tag: string) => {
      for (let g = 0; g < n; g++) {
        const rng = createRandom(tag + g);
        const cfg = config({
          seed: tag + g, mode, deckSize: 24 + rng.nextInt(0, 60), players: bots(levels), farmers: g % 7 !== 0,
          params: { ...DEFAULT_DECK_PARAMS, cityDensity: 0.6 + rng.nextFloat(), roadDensity: 0.6 + rng.nextFloat(), complexity: 0.5 + rng.nextFloat() * 1.5, diversity: 0.6 + rng.nextFloat() },
        });
        const r = playBotGame(cfg);
        expect(r.state.phase).toBe(TurnPhase.GAME_OVER);
        const errors = checkInvariants(r.state);
        if (errors.length) throw new Error(`${cfg.seed}: ${errors.join("; ")}`);
        games++; tiles += r.state.tiles.length; discarded += r.state.discarded.length;
        if (levels.length === 2 && levels[0] === levels[1]) {
          const [a, b] = r.state.players.map((p) => p.score);
          scoreSum[0] += a; scoreSum[1] += b;
          if (a !== b) { decided++; if (a > b) firstWins++; }
        }
      }
    };
    run(1400, "classic", ["easy", "easy"], "ce");
    run(1000, "procedural", ["easy", "easy", "easy"], "pe");
    run(300, "classic", ["normal", "normal"], "cn");
    run(200, "procedural", ["normal", "easy", "normal", "easy"], "pn");
    run(100, "procedural", ["normal", "normal"], "pn2");
    const share = firstWins / decided;
    console.log(`${games} games, ${tiles} tiles placed, ${discarded} discarded (${((100 * discarded) / (tiles + discarded)).toFixed(2)} %), first player wins ${(100 * share).toFixed(1)} % of ${decided} decided mirror games, mean scores ${(scoreSum[0] / 1800).toFixed(1)} / ${(scoreSum[1] / 1800).toFixed(1)}, ${Date.now() - t0} ms`);
    expect(games).toBe(3000);
    // Seat order must not decide mirror games (binomial 3-sigma band around 50 %).
    expect(Math.abs(share - 0.5)).toBeLessThan(3 * Math.sqrt(0.25 / decided) + 0.03);
    expect(discarded / (tiles + discarded)).toBeLessThan(0.05);
  });

  it("random walks through the action space keep every invariant at every step", () => {
    for (let g = 0; g < 60; g++) {
      const rng = createRandom("walk" + g);
      let s = createGame(config({ seed: "walk" + g, mode: g % 2 ? "procedural" : "classic", deckSize: 50, players: bots(["easy", "easy", "easy"].slice(0, 2 + (g % 2)) as BotLevel[]) }));
      let steps = 0;
      while (s.phase !== TurnPhase.GAME_OVER) {
        const before = stateHash(s);
        if (s.phase === TurnPhase.PLACE_TILE) {
          const ps = legalPlacements(s);
          expect(ps.length).toBeGreaterThan(0);
          const r = applyAction(s, { type: "PLACE_TILE", ...ps[rng.nextInt(0, ps.length - 1)] });
          if (!r.ok) throw new Error(r.error);
          expect(stateHash(s)).toBe(before);
          s = r.state;
        } else if (s.phase === TurnPhase.PLACE_MEEPLE) {
          const opts = meepleOptions(s).filter((o) => o.allowed);
          const pick = rng.nextFloat() < 0.6 && opts.length ? opts[rng.nextInt(0, opts.length - 1)] : null;
          const r = applyAction(s, pick ? { type: "PLACE_MEEPLE", regionId: pick.regionId } : { type: "SKIP_MEEPLE" });
          if (!r.ok) throw new Error(r.error);
          s = r.state;
        } else throw new Error("stuck in " + s.phase);
        const errors = checkInvariants(s);
        if (errors.length) throw new Error(`walk${g} step ${steps}: ${errors.join("; ")}`);
        steps++;
      }
    }
  });
});
