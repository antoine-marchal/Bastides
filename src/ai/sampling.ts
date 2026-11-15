import type { TileDef } from "../core/types";
import type { RandomSource } from "../core/random";
import { topologyWeights } from "../game/deck";
import type { DeckParams } from "../game/state";

let cache: { key: string; ids: string[]; weights: number[] } | null = null;
/** Sample a plausible sandbox tile from the PUBLIC generation parameters with the bot's own stream. */
export function sandboxTileFromRng(rng: RandomSource, params: DeckParams): TileDef {
  const key = JSON.stringify(params);
  if (!cache || cache.key !== key) cache = { key, ...topologyWeights(params) };
  return { topologyId: rng.weightedChoice(cache.ids, cache.weights), seed: 0 };
}
