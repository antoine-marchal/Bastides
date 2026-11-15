/**
 * Deck construction. A deck is fixed and shuffled BEFORE the game starts; nothing here
 * looks at players, scores or the board (no adaptive draws).
 */
import type { TileDef } from "../core/types";
import { createRandom } from "../core/random";
import type { RandomSource } from "../core/random";
import { catalog, classicComposition, startTopologyId } from "../procedural/topology/catalog";
import type { CatalogEntry } from "../procedural/topology/catalog";
import type { DeckParams, GameConfig } from "./state";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Sampling weight of a topology for the procedural deck. */
export function topologyWeight(e: CatalogEntry, p: DeckParams, classicIds: Set<string>): number {
  const st = e.stats;
  let w = Math.pow(clamp(p.cityDensity, 0.1, 4), st.citySides) * Math.pow(clamp(p.roadDensity, 0.1, 4), st.roadSides) * Math.pow(clamp(p.grassDensity, 0.1, 4), st.grassSides);
  // Structural priors keep the deck strategically sound (closable cities, usable roads).
  w *= [1.25, 1.1, 0.95, 0.5, 0.18][st.citySides];
  w *= [0.9, 0.55, 1.25, 0.6, 0.3][st.roadSides];
  if (st.monastery) w *= 0.45 * p.monasteryFreq;
  if (st.shields) w *= Math.pow(0.5 * p.shieldFreq, st.shields);
  if (st.junction) w *= 0.7 * p.junctionFreq;
  if (st.throughCity) w *= 0.7 * p.throughCityFreq;
  if (st.regions > 4) w *= Math.exp((-(st.regions - 4) * 0.35) / clamp(p.complexity, 0.2, 4));
  if (e.topology.fields.some((f) => f.ports.length === 0)) w *= 0.25;
  if (!classicIds.has(e.topology.id)) w *= 0.4;
  return Math.pow(Math.max(w, 0), 1 / clamp(p.diversity, 0.3, 3));
}

export function topologyWeights(p: DeckParams): { ids: string[]; weights: number[] } {
  const classicIds = new Set(classicComposition().map((c) => c.id));
  const ids: string[] = [], weights: number[] = [];
  for (const [id, e] of catalog()) { ids.push(id); weights.push(topologyWeight(e, p, classicIds)); }
  return { ids, weights };
}

function withSeeds(ids: string[], rng: RandomSource): TileDef[] {
  return ids.map((topologyId) => ({ topologyId, seed: rng.nextUint32() }));
}

/** Classic 72-tile deck: starting tile first, the other 71 shuffled (Fisher-Yates). */
export function classicDeck(secret: string): TileDef[] {
  const rest: string[] = [];
  const start = startTopologyId();
  let startTaken = false;
  for (const c of classicComposition()) for (let i = 0; i < c.count; i++) {
    if (c.id === start && !startTaken) { startTaken = true; continue; }
    rest.push(c.id);
  }
  createRandom(secret + "/deck/order").shuffle(rest);
  return withSeeds([start, ...rest], createRandom(secret + "/deck/tiles"));
}

/**
 * Procedural deck under quotas: expected counts follow the weights (largest-remainder
 * rounding with seeded tie-breaks) so that a deck is never wildly unbalanced, then shuffled.
 */
export function proceduralDeck(secret: string, size: number, params: DeckParams): TileDef[] {
  const n = Math.max(2, Math.floor(size)) - 1;
  const { ids, weights } = topologyWeights(params);
  const total = weights.reduce((a, b) => a + b, 0);
  const rng = createRandom(secret + "/deck/quota");
  const exact = weights.map((w) => (w / total) * n);
  const counts = exact.map(Math.floor);
  let left = n - counts.reduce((a, b) => a + b, 0);
  const frac = exact.map((x, i) => x - counts[i]);
  while (left > 0) {
    const pick = rng.weightedChoice(ids.map((_, i) => i), frac.map((f) => f + 1e-9));
    counts[pick]++;
    frac[pick] = 0;
    left--;
  }
  const rest: string[] = [];
  ids.forEach((id, i) => { for (let k = 0; k < counts[i]; k++) rest.push(id); });
  createRandom(secret + "/deck/order").shuffle(rest);
  return withSeeds([startTopologyId(), ...rest], createRandom(secret + "/deck/tiles"));
}

/** Endless sandbox: tile i is a pure function of (secret, i) — explicit, non-competitive generation. */
export function sandboxTile(secret: string, index: number, params: DeckParams): TileDef {
  const rng = createRandom(secret + "/sandbox/" + index);
  if (index === 0) return { topologyId: startTopologyId(), seed: rng.nextUint32() };
  const { ids, weights } = cachedWeights(params);
  return { topologyId: rng.weightedChoice(ids, weights), seed: rng.nextUint32() };
}
let weightCache: { key: string; value: { ids: string[]; weights: number[] } } | null = null;
function cachedWeights(p: DeckParams) {
  const key = JSON.stringify(p);
  if (!weightCache || weightCache.key !== key) weightCache = { key, value: topologyWeights(p) };
  return weightCache.value;
}

/** Build the secret deck of a game. `secret` must stay on the host in network games. */
export function buildDeck(config: GameConfig, secret: string): TileDef[] {
  if (config.mode === "classic") return classicDeck(secret);
  if (config.mode === "procedural") return proceduralDeck(secret, config.deckSize, config.params);
  return [sandboxTile(secret, 0, config.params)];
}
