/**
 * The four bot levels. A bot receives a PUBLIC view and returns a decision; it never
 * mutates the game: its choice is replayed through the same validators as human actions.
 *
 *   easy   RandomBot      random legal placement, naive meeple use
 *   normal GreedyBot      immediate points, completions, meeple economy
 *   hard   StrategicBot   expected value of every claimed region for every player
 *   expert MonteCarloBot  strategic shortlist + determinised rollouts (hidden draw order sampled)
 */
import { createRandom } from "../core/random";
import type { RandomSource } from "../core/random";
import { applyUnchecked, cloneState, legalPlacements, meepleOptions, regionOf, regionPoints, validateAction } from "../game/gameEngine";
import type { Placement } from "../game/gameEngine";
import { TurnPhase } from "../game/state";
import type { BotLevel, GameAction, GameState } from "../game/state";
import { makeContext, utility } from "./evaluation";
import { determinize } from "./view";

export interface BotTurn {
  place: Placement;
  /** Local region id to claim, or null to skip. */
  meeple: number | null;
}

export interface BotOptions {
  level: BotLevel;
  /** Key of the bot's private random stream for this decision. */
  seedKey: string;
  /** Monte-Carlo budget (number of rollouts). Deterministic. */
  simulations?: number;
  /** Optional wall-clock cap (UX only; makes the result time-dependent). */
  timeLimitMs?: number;
}

export const DEFAULT_SIMULATIONS = 160;

export function botSeedKey(state: GameState, playerIndex = state.player): string {
  return `${state.config.seed}/bot:${playerIndex}/turn:${state.turn}`;
}

interface Candidate { place: Placement; meeple: number | null; after: GameState }

/** Every (placement, meeple decision) of the current tile with its resulting state. */
export function enumerateTurns(view: GameState): Candidate[] {
  const out: Candidate[] = [];
  const me = view.player, turn = view.turn;
  for (const place of legalPlacements(view)) {
    const placed = cloneState(view);
    applyUnchecked(placed, { type: "PLACE_TILE", ...place });
    if (placed.phase !== TurnPhase.PLACE_MEEPLE || placed.player !== me || placed.turn !== turn) { out.push({ place, meeple: null, after: placed }); continue; }
    for (const o of meepleOptions(placed)) {
      if (!o.allowed) continue;
      const s = cloneState(placed);
      applyUnchecked(s, { type: "PLACE_MEEPLE", regionId: o.regionId });
      out.push({ place, meeple: o.regionId, after: s });
    }
    applyUnchecked(placed, { type: "SKIP_MEEPLE" });
    out.push({ place, meeple: null, after: placed });
  }
  return out;
}

function pickBest(cands: Candidate[], score: (c: Candidate) => number, rng: RandomSource): Candidate {
  let best = cands[0], bestScore = -Infinity;
  for (const c of cands) {
    const s = score(c) + rng.nextFloat() * 1e-6; // seeded tie-break
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return best;
}

function randomTurn(view: GameState, rng: RandomSource): BotTurn {
  const places = legalPlacements(view);
  const place = places[rng.nextInt(0, places.length - 1)];
  const s = cloneState(view);
  applyUnchecked(s, { type: "PLACE_TILE", ...place });
  let meeple: number | null = null;
  if (s.phase === TurnPhase.PLACE_MEEPLE && s.turn === view.turn) {
    const opts = meepleOptions(s).filter((o) => o.allowed && (o.kind !== "field" || rng.nextFloat() < 0.2));
    if (opts.length && rng.nextFloat() < 0.45) meeple = opts[rng.nextInt(0, opts.length - 1)].regionId;
  }
  return { place, meeple };
}

/** Greedy score: points gained now, plus the face value of what a new meeple holds. */
function greedyScore(view: GameState, c: Candidate): number {
  const me = view.player;
  let s = (c.after.players[me].score - view.players[me].score) * 1.0;
  s += (c.after.players[me].meeples - view.players[me].meeples) * 0.6; // meeples coming home
  if (c.meeple !== null && c.after.players[me].meeples < view.players[me].meeples) {
    // The meeple stays on the board: value what it currently holds.
    const tile = c.after.tiles[c.after.tiles.length - 1];
    const region = regionOf(c.after, tile.base + c.meeple);
    const pts = regionPoints(c.after, region, true).points;
    s += region.kind === "field" ? 0.5 * pts - 1.5 : 0.45 * pts;
    s -= view.players[me].meeples <= 2 ? 2 : 0.4;
  }
  return s;
}

function strategicCandidates(view: GameState): { c: Candidate; u: number }[] {
  const me = view.player;
  return enumerateTurns(view).map((c) => ({ c, u: utility(c.after, me, makeContext(c.after)) }));
}

/** Fast rollout policy: best of a few random placements by immediate gain, light meeple use. */
function rolloutPly(s: GameState, rng: RandomSource): void {
  const places = legalPlacements(s);
  const me = s.player, turn = s.turn;
  let best: GameState | null = null, bestGain = -Infinity;
  const tries = Math.min(3, places.length);
  for (let i = 0; i < tries; i++) {
    const p = places[rng.nextInt(0, places.length - 1)];
    const t = cloneState(s);
    applyUnchecked(t, { type: "PLACE_TILE", ...p });
    if (t.phase === TurnPhase.PLACE_MEEPLE && t.player === me && t.turn === turn) {
      const opts = meepleOptions(t).filter((o) => o.allowed && o.kind !== "field");
      let action: GameAction = { type: "SKIP_MEEPLE" };
      if (opts.length && t.players[me].meeples > 1) {
        const closing = opts.find((o) => o.kind !== "monastery" && regionOf(t, t.tiles[t.lastTile].base + o.regionId).open === 0);
        if (closing) action = { type: "PLACE_MEEPLE", regionId: closing.regionId };
        else if (rng.nextFloat() < 0.35) action = { type: "PLACE_MEEPLE", regionId: opts[rng.nextInt(0, opts.length - 1)].regionId };
      }
      applyUnchecked(t, action);
    }
    const gain = t.players[me].score - s.players[me].score + rng.nextFloat() * 0.5;
    if (gain > bestGain) { bestGain = gain; best = t; }
  }
  Object.assign(s, best!);
}

function monteCarloTurn(view: GameState, opts: BotOptions, rng: RandomSource): BotTurn {
  const me = view.player;
  const ranked = strategicCandidates(view).sort((a, b) => b.u - a.u);
  const shortlist = ranked.slice(0, 6);
  if (shortlist.length <= 1) return { place: shortlist[0].c.place, meeple: shortlist[0].c.meeple };
  const budget = Math.max(shortlist.length, opts.simulations ?? DEFAULT_SIMULATIONS);
  const per = Math.floor(budget / shortlist.length);
  const horizon = view.players.length * 2;
  const deadline = opts.timeLimitMs ? Date.now() + opts.timeLimitMs : Infinity;
  const sums = shortlist.map(() => 0), counts = shortlist.map(() => 0);
  outer: for (let k = 0; k < per; k++) {
    // Common random numbers: every candidate faces the same sampled future in round k.
    for (let i = 0; i < shortlist.length; i++) {
      if (Date.now() > deadline) break outer;
      const sim = determinize(shortlist[i].c.after, rng.fork("world:" + k));
      const policy = rng.fork("policy:" + k);
      if (sim.phase === TurnPhase.DRAW_TILE) redraw(sim);
      for (let ply = 0; ply < horizon && sim.phase === TurnPhase.PLACE_TILE; ply++) rolloutPly(sim, policy);
      sums[i] += utility(sim, me, makeContext(sim));
      counts[i]++;
    }
  }
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < shortlist.length; i++) {
    const mc = counts[i] ? sums[i] / counts[i] : shortlist[i].u;
    const score = 0.5 * shortlist[i].u + 0.5 * mc;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return { place: shortlist[best].c.place, meeple: shortlist[best].c.meeple };
}

/** A determinised state that was waiting for a reveal resumes its draw through a no-op clone. */
function redraw(sim: GameState): void {
  // The view stopped in DRAW_TILE because the next tile was unknown; now the deck is filled.
  const d = sim.deck;
  while (sim.phase === TurnPhase.DRAW_TILE && d.pos < d.tiles.length) {
    const tile = d.tiles[d.pos++];
    if (legalPlacements(sim, tile).length) { sim.current = tile; sim.phase = TurnPhase.PLACE_TILE; } else sim.discarded.push(tile);
  }
}

/** Decide a full turn (placement + meeple) for the active player of a public view. */
export function chooseTurn(view: GameState, opts: BotOptions): BotTurn {
  if (view.phase !== TurnPhase.PLACE_TILE || !view.current) throw new Error("chooseTurn: no tile to place");
  const rng = createRandom(opts.seedKey);
  switch (opts.level) {
    case "easy":
      return randomTurn(view, rng);
    case "normal": {
      const c = pickBest(enumerateTurns(view), (x) => greedyScore(view, x), rng);
      return { place: c.place, meeple: c.meeple };
    }
    case "hard": {
      const ranked = strategicCandidates(view);
      let best = ranked[0];
      for (const r of ranked) if (r.u > best.u) best = r;
      return { place: best.c.place, meeple: best.c.meeple };
    }
    default:
      return monteCarloTurn(view, opts, rng);
  }
}

/** Always-legal fallback (first legal placement, no meeple). */
export function fallbackTurn(view: GameState): BotTurn {
  return { place: legalPlacements(view)[0], meeple: null };
}

/** Turn a bot decision into engine actions, validating each against the given state. */
export function turnActions(turn: BotTurn): GameAction[] {
  return [{ type: "PLACE_TILE", ...turn.place }, turn.meeple === null ? { type: "SKIP_MEEPLE" } : { type: "PLACE_MEEPLE", regionId: turn.meeple }];
}
export { validateAction };
