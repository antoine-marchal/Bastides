/**
 * Public view of a game: exactly what a player at the table may know.
 * The hidden draw order is replaced by the sorted multiset of unseen tiles ("pool"),
 * which is public knowledge (deck composition minus revealed tiles).
 * Bots only ever receive such a view, so they cannot peek at future draws.
 */
import type { TileDef } from "../core/types";
import type { RandomSource } from "../core/random";
import { sandboxTileFromRng } from "./sampling";
import { cloneState } from "../game/gameEngine";
import type { GameState } from "../game/state";

export function publicView(state: GameState): GameState {
  const view = cloneState(state);
  const d = state.deck;
  const pool: TileDef[] = d.total >= 0 ? d.tiles.slice(d.pos, d.total) : [];
  // Sort by topology only and blank the per-tile seeds: order and identity carry no information.
  pool.sort((a, b) => (a.topologyId < b.topologyId ? -1 : a.topologyId > b.topologyId ? 1 : 0));
  view.deck = { tiles: d.tiles.slice(0, d.pos), pos: d.pos, total: d.total, pool: pool.map((t) => ({ topologyId: t.topologyId, seed: 0 })) };
  view.replica = true;
  return view;
}

/**
 * Determinisation: a full state consistent with the view, where the unseen tiles are
 * ordered by the caller's own random stream (never by the real deck).
 */
export function determinize(view: GameState, rng: RandomSource, sandboxHorizon = 12): GameState {
  const s = cloneState(view);
  const pool = (view.deck.pool ?? []).slice();
  rng.shuffle(pool);
  const tiles = view.deck.tiles.slice(0, view.deck.pos).concat(pool);
  if (view.deck.total < 0) for (let i = 0; i < sandboxHorizon; i++) tiles.push(sandboxTileFromRng(rng, view.config.params));
  s.deck = { tiles, pos: view.deck.pos, total: view.deck.total < 0 ? tiles.length : view.deck.total };
  s.replica = false;
  return s;
}
