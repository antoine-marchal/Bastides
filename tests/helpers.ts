import type { TileDef } from "../src/core/types";
import { canonicalSpec } from "../src/procedural/topology/catalog";
import { parseSpecId, rotateSpec, specId } from "../src/procedural/topology/generator";
import { applyAction, createGame, tileTopology, topoIndex } from "../src/game/gameEngine";
import { DEFAULT_DECK_PARAMS, TurnPhase } from "../src/game/state";
import type { GameConfig, GameState, PlayerConfig } from "../src/game/state";

/** A tile given by a raw (oriented) id: canonical def + rotation reproducing that orientation. */
export function oriented(raw: string): { def: TileDef; rotation: number } {
  const want = specId(parseSpecId(raw));
  const { spec } = canonicalSpec(parseSpecId(raw));
  for (let r = 0; r < 4; r++) if (specId(rotateSpec(spec, r)) === want) return { def: { topologyId: specId(spec), seed: 1 }, rotation: r };
  throw new Error("cannot orient " + raw);
}

export function players(n: number, kind: "human" | "bot" = "human"): PlayerConfig[] {
  return Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i, color: i, kind, level: "normal" as const }));
}
export function config(over: Partial<GameConfig> = {}): GameConfig {
  return { mode: "classic", deckSize: 72, params: { ...DEFAULT_DECK_PARAMS }, farmers: true, players: players(2), seed: "test", ...over };
}

export type Claim = null | { city: number } | { road: number } | { field: number } | "monastery";
export interface Step { raw: string; x: number; y: number; claim?: Claim }

/** Scripted game on the standard start tile (city N, road E-W at 0,0). Deck = the steps in order. */
export function scripted(steps: Step[], over: Partial<GameConfig> = {}): GameState {
  const tiles = [oriented("CRFR-c0-r13").def, ...steps.map((s) => oriented(s.raw).def)];
  let state = createGame(config(over), { tiles });
  for (const step of steps) state = playStep(state, step);
  return state;
}

export function playStep(state: GameState, step: Step): GameState {
  const o = oriented(step.raw);
  if (!state.current || state.current.topologyId !== o.def.topologyId) throw new Error(`expected ${step.raw} to be the current tile, got ${state.current?.topologyId}`);
  let r = applyAction(state, { type: "PLACE_TILE", x: step.x, y: step.y, rotation: o.rotation });
  if (!r.ok) throw new Error(`${step.raw} @${step.x},${step.y}: ${r.error}`);
  state = r.state;
  if (state.phase !== TurnPhase.PLACE_MEEPLE) return state;
  if (!step.claim) r = applyAction(state, { type: "SKIP_MEEPLE" });
  else r = applyAction(state, { type: "PLACE_MEEPLE", regionId: featureOf(state, step.claim) });
  if (!r.ok) throw new Error(`${step.raw} claim: ${r.error}`);
  return r.state;
}

/** Local feature of the last placed tile designated by a side (city/road) or a field port. */
export function featureOf(state: GameState, claim: Exclude<Claim, null>, tileIndex = state.lastTile): number {
  const ix = topoIndex(tileTopology(state.tiles[tileIndex]));
  if (claim === "monastery") return ix.monastery;
  if ("field" in claim) return ix.port[claim.field];
  return ix.side["city" in claim ? claim.city : claim.road];
}
