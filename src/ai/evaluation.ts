/**
 * Static evaluation shared by the strategic and Monte-Carlo bots.
 * Uses only public information: board, meeples, scores and the multiset of unseen tiles.
 */
import { DX, DY, cellKey } from "../core/coordinates";
import { getEntry, rotatedById } from "../procedural/topology/catalog";
import { completedCitiesOfField, distinctTiles, find, majority, monasteryNeighbours, tileAt, tileTopology, tilesRemaining, topoIndex } from "../game/gameEngine";
import { TurnPhase } from "../game/state";
import type { GameState, Region } from "../game/state";

export interface EvalContext {
  /** Distinct unseen topologies with multiplicities. */
  pool: { id: string; count: number }[];
  poolSize: number;
  remaining: number;
  fitCache: Map<number, number>;
}

export function makeContext(state: GameState): EvalContext {
  const counts = new Map<string, number>();
  const src = state.deck.pool ?? (state.deck.total >= 0 ? state.deck.tiles.slice(state.deck.pos, state.deck.total) : []);
  for (const t of src) counts.set(t.topologyId, (counts.get(t.topologyId) ?? 0) + 1);
  const rem = tilesRemaining(state);
  return { pool: [...counts].map(([id, count]) => ({ id, count })), poolSize: src.length, remaining: rem < 0 ? 40 : rem, fitCache: new Map() };
}

/** Fraction of unseen tiles that could legally fill the empty cell (x, y). */
export function fitFraction(state: GameState, ctx: EvalContext, x: number, y: number): number {
  const key = cellKey(x, y);
  const hit = ctx.fitCache.get(key);
  if (hit !== undefined) return hit;
  let value = 0.5;
  if (ctx.poolSize > 0) {
    const need: number[] = [-1, -1, -1, -1];
    for (let s = 0; s < 4; s++) {
      const nb = tileAt(state, x + DX[s], y + DY[s]);
      if (nb) need[s] = tileTopology(nb).edges[(s + 2) & 3];
    }
    let fit = 0;
    for (const p of ctx.pool) {
      const sym = getEntry(p.id).symmetry;
      for (let r = 0; r < sym; r++) {
        const e = rotatedById(p.id, r).edges;
        if ((need[0] < 0 || e[0] === need[0]) && (need[1] < 0 || e[1] === need[1]) && (need[2] < 0 || e[2] === need[2]) && (need[3] < 0 || e[3] === need[3])) { fit += p.count; break; }
      }
    }
    value = fit / ctx.poolSize;
  }
  ctx.fitCache.set(key, value);
  return value;
}

/** Empty cells facing the open interfaces of a road/city region. */
export function openSlots(state: GameState, root: number, region: Region): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<number>();
  for (const ti of distinctTiles(region)) {
    const tile = state.tiles[ti];
    const ix = topoIndex(tileTopology(tile));
    for (let s = 0; s < 4; s++) {
      const f = ix.side[s];
      if (f < 0 || find(state, tile.base + f) !== root) continue;
      const x = tile.x + DX[s], y = tile.y + DY[s], k = cellKey(x, y);
      if (state.board.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push([x, y]);
    }
  }
  return out;
}

/** Probability estimate that a road/city region gets completed before the game ends. */
export function completionProbability(state: GameState, ctx: EvalContext, root: number, region: Region): number {
  if (region.open === 0) return 1;
  const draws = (ctx.remaining * 0.7) / Math.max(1, state.players.length - 1);
  let p = 1;
  for (const [x, y] of openSlots(state, root, region)) {
    const f = fitFraction(state, ctx, x, y);
    if (f <= 0) return 0;
    p *= 1 - Math.pow(1 - Math.min(0.95, f), draws);
  }
  return p * Math.pow(0.88, region.open);
}

const HAND_VALUE = [-7, 0, 2.6, 4.6, 6.1, 7.1, 7.7, 8];

/** Expected final value of each player (score + discounted potential of claimed regions). */
export function expectedValues(state: GameState, ctx: EvalContext = makeContext(state)): number[] {
  const n = state.players.length;
  const v = state.players.map((p) => p.score);
  if (state.phase === TurnPhase.GAME_OVER) return v;
  const cityProb = new Map<number, number>();
  const probOfCity = (root: number) => {
    let p = cityProb.get(root);
    if (p === undefined) { p = completionProbability(state, ctx, root, state.regions.get(root)!); cityProb.set(root, p); }
    return p;
  };
  for (const [root, region] of state.regions) {
    if (region.meeples.length === 0 || region.done) continue;
    let value = 0;
    const tiles = distinctTiles(region).length;
    if (region.kind === "road") {
      const p = completionProbability(state, ctx, root, region);
      value = tiles + p * (0.4 * region.open + 0.8);
    } else if (region.kind === "city") {
      const p = probOfCity(root);
      value = (tiles + region.shields) * (1 + p) + p * region.open * 1.1;
    } else if (region.kind === "monastery") {
      const k = monasteryNeighbours(state, state.tiles[region.tiles[0]]);
      const q = Math.min(0.85, ctx.remaining / (ctx.remaining + 10));
      value = 1 + k + (8 - k) * q + (k >= 5 ? q : 0);
    } else {
      value = 3 * completedCitiesOfField(state, region).length;
      const seen = new Set<number>();
      for (const c of region.cities) {
        const r = find(state, c);
        if (seen.has(r)) continue;
        seen.add(r);
        const city = state.regions.get(r)!;
        if (city.open > 0) value += 3 * probOfCity(r) * 0.8;
      }
      value += 0.6;
    }
    const { winners } = majority(region, n);
    for (const w of winners) v[w] += value;
  }
  const timeLeft = Math.min(1, ctx.remaining / (n * 3));
  for (let i = 0; i < n; i++) v[i] += HAND_VALUE[Math.min(7, state.players[i].meeples)] * timeLeft;
  return v;
}

/** Utility of a position for one player: own expected value against the strongest rival. */
export function utility(state: GameState, player: number, ctx?: EvalContext): number {
  const v = expectedValues(state, ctx);
  let best = -Infinity, sum = 0;
  for (let i = 0; i < v.length; i++) if (i !== player) { best = Math.max(best, v[i]); sum += v[i]; }
  const others = v.length - 1;
  return v[player] - 0.7 * best - (others > 1 ? (0.3 * (sum - best)) / (others - 1) : 0.3 * best);
}
