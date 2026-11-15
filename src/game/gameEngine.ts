/**
 * Deterministic game automaton:  GameState + GameAction -> new GameState.
 *
 * Everything (humans, bots, network clients, replays) goes through applyAction().
 * The UI never mutates a state. SCORE_FEATURES, END_TURN and DRAW_TILE are transient
 * phases executed automatically by the automaton once the meeple decision is known.
 */
import { Terrain } from "../core/types";
import type { FeatureKind, TileDef, TileTopology } from "../core/types";
import { DX, DY, NEIGHBOURS8, cellKey, keyX, keyY, matchingPort } from "../core/coordinates";
import { canonicalJson, sha256 } from "../core/hash";
import { getEntry, rotatedById } from "../procedural/topology/catalog";
import { buildDeck, sandboxTile } from "./deck";
import { MEEPLES_PER_PLAYER, TurnPhase } from "./state";
import type { ApplyResult, GameAction, GameConfig, GameState, Meeple, PlacedTile, PlayerState, Region, ScoreEvent } from "./state";

// ---------------------------------------------------------------------------------------
// Per-topology lookup tables
// ---------------------------------------------------------------------------------------
interface TopoIndex {
  n: number;
  kinds: FeatureKind[];
  /** Local feature owning the main interface of each side (-1 for grass). */
  side: number[];
  /** Local feature (field) owning each field port (-1 on city sides). */
  port: number[];
  monastery: number;
}
const indexCache = new WeakMap<TileTopology, TopoIndex>();
export function topoIndex(t: TileTopology): TopoIndex {
  let ix = indexCache.get(t);
  if (ix) return ix;
  const nc = t.cities.length, nr = t.roads.length, nf = t.fields.length;
  const kinds: FeatureKind[] = [...t.cities.map(() => "city" as const), ...t.roads.map(() => "road" as const), ...t.fields.map(() => "field" as const)];
  if (t.monastery) kinds.push("monastery");
  const side = [-1, -1, -1, -1], port = new Array<number>(8).fill(-1);
  t.cities.forEach((c, i) => c.sides.forEach((s) => (side[s] = i)));
  t.roads.forEach((r, i) => r.sides.forEach((s) => (side[s] = nc + i)));
  t.fields.forEach((f, i) => f.ports.forEach((p) => (port[p] = nc + nr + i)));
  ix = { n: kinds.length, kinds, side, port, monastery: t.monastery ? nc + nr + nf : -1 };
  indexCache.set(t, ix);
  return ix;
}

export function tileTopology(tile: { def: TileDef; rotation: number }): TileTopology {
  return rotatedById(tile.def.topologyId, tile.rotation);
}

// ---------------------------------------------------------------------------------------
// Union-find over feature nodes
// ---------------------------------------------------------------------------------------
export function find(state: GameState, node: number): number {
  const p = state.parent;
  while (p[node] !== node) node = p[node];
  return node;
}
export function regionOf(state: GameState, node: number): Region {
  return state.regions.get(find(state, node))!;
}
function union(state: GameState, a: number, b: number): number {
  let ra = find(state, a), rb = find(state, b);
  if (ra === rb) return ra;
  const A = state.regions.get(ra)!, B = state.regions.get(rb)!;
  // Union by size keeps the forest shallow without path compression.
  if (A.tiles.length < B.tiles.length) return union(state, rb, ra);
  state.parent[rb] = ra;
  A.open += B.open;
  A.shields += B.shields;
  for (const t of B.tiles) A.tiles.push(t);
  for (const m of B.meeples) A.meeples.push(m);
  for (const c of B.cities) A.cities.push(c);
  state.regions.delete(rb);
  return ra;
}

// ---------------------------------------------------------------------------------------
// Board and placement
// ---------------------------------------------------------------------------------------
export function tileAt(state: GameState, x: number, y: number): PlacedTile | undefined {
  const i = state.board.get(cellKey(x, y));
  return i === undefined ? undefined : state.tiles[i];
}

/** Is (def, rotation) legal at (x, y)? Needs an empty frontier cell and matching edges on all sides. */
export function canPlace(state: GameState, def: TileDef, x: number, y: number, rotation: number): boolean {
  if (!state.frontier.has(cellKey(x, y))) return false;
  const edges = rotatedById(def.topologyId, rotation).edges;
  for (let s = 0; s < 4; s++) {
    const nb = tileAt(state, x + DX[s], y + DY[s]);
    if (nb && tileTopology(nb).edges[(s + 2) & 3] !== edges[s]) return false;
  }
  return true;
}

export interface Placement { x: number; y: number; rotation: number }

/** All legal placements; only distinct orientations are tested, only frontier cells visited. */
export function legalPlacements(state: GameState, def: TileDef | null = state.current): Placement[] {
  if (!def) return [];
  const out: Placement[] = [];
  const sym = getEntry(def.topologyId).symmetry;
  for (const key of state.frontier) {
    const x = keyX(key), y = keyY(key);
    for (let r = 0; r < sym; r++) if (canPlace(state, def, x, y, r)) out.push({ x, y, rotation: r });
  }
  return out;
}
export function hasLegalPlacement(state: GameState, def: TileDef): boolean {
  const sym = getEntry(def.topologyId).symmetry;
  for (const key of state.frontier) {
    const x = keyX(key), y = keyY(key);
    for (let r = 0; r < sym; r++) if (canPlace(state, def, x, y, r)) return true;
  }
  return false;
}

function putTile(state: GameState, def: TileDef, x: number, y: number, rotation: number, by: number): number {
  const topo = rotatedById(def.topologyId, rotation);
  const ix = topoIndex(topo);
  const base = state.parent.length;
  const tileIdx = state.tiles.length;
  const nc = topo.cities.length, nr = topo.roads.length;
  for (let f = 0; f < ix.n; f++) {
    state.parent.push(base + f);
    const kind = ix.kinds[f];
    const region: Region = { kind, open: 0, tiles: [tileIdx], shields: 0, meeples: [], cities: [], done: false };
    if (kind === "city") { region.open = topo.cities[f].sides.length; region.shields = topo.cities[f].shields; }
    else if (kind === "road") region.open = topo.roads[f - nc].sides.length;
    else if (kind === "field") region.cities = topo.fields[f - nc - nr].adjacentCityIds.map((c) => base + c);
    state.regions.set(base + f, region);
  }
  state.tiles.push({ def, x, y, rotation, base, by });
  const key = cellKey(x, y);
  state.board.set(key, tileIdx);
  state.frontier.delete(key);
  for (let s = 0; s < 4; s++) {
    const nx = x + DX[s], ny = y + DY[s];
    const nk = cellKey(nx, ny);
    const ni = state.board.get(nk);
    if (ni === undefined) { state.frontier.add(nk); continue; }
    const nb = state.tiles[ni];
    const nix = topoIndex(tileTopology(nb));
    const os = (s + 2) & 3;
    if (topo.edges[s] !== Terrain.GRASS) {
      // Main interfaces: roads with roads, cities with cities (edges are known to match).
      const root = union(state, base + ix.side[s], nb.base + nix.side[os]);
      state.regions.get(root)!.open -= 2;
    }
    if (topo.edges[s] !== Terrain.CITY) {
      // Field ports: secondary port 0 faces secondary port 1 of the opposite side.
      for (const p of [s * 2, s * 2 + 1]) union(state, base + ix.port[p], nb.base + nix.port[matchingPort(p)]);
    }
  }
  return tileIdx;
}

// ---------------------------------------------------------------------------------------
// Meeples
// ---------------------------------------------------------------------------------------
export type MeepleBlock = "" | "occupied" | "no-meeple" | "farmers-disabled";
export interface MeepleOption { regionId: number; kind: FeatureKind; allowed: boolean; reason: MeepleBlock }

/** Claimable features of the tile just placed (checked AFTER the merges it caused). */
export function meepleOptions(state: GameState): MeepleOption[] {
  if (state.phase !== TurnPhase.PLACE_MEEPLE || state.lastTile < 0) return [];
  const tile = state.tiles[state.lastTile];
  const ix = topoIndex(tileTopology(tile));
  const out: MeepleOption[] = [];
  for (let f = 0; f < ix.n; f++) {
    const region = regionOf(state, tile.base + f);
    let reason: MeepleBlock = "";
    if (state.players[state.player].meeples <= 0) reason = "no-meeple";
    else if (ix.kinds[f] === "field" && !state.config.farmers) reason = "farmers-disabled";
    else if (region.meeples.length > 0) reason = "occupied";
    out.push({ regionId: f, kind: ix.kinds[f], allowed: reason === "", reason });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------
export function distinctTiles(region: Region): number[] {
  return [...new Set(region.tiles)];
}
export function monasteryNeighbours(state: GameState, tile: PlacedTile): number {
  let n = 0;
  for (const [dx, dy] of NEIGHBOURS8) if (state.board.has(cellKey(tile.x + dx, tile.y + dy))) n++;
  return n;
}
/** Distinct completed cities adjacent to a field region. */
export function completedCitiesOfField(state: GameState, field: Region): number[] {
  const roots = new Set<number>();
  for (const c of field.cities) {
    const r = find(state, c);
    if (state.regions.get(r)!.open === 0) roots.add(r);
  }
  return [...roots];
}

/** Points a region is worth now (final = end-of-game values for incomplete features). */
export function regionPoints(state: GameState, region: Region, final: boolean): { points: number; tiles: number; reason: string } {
  const tiles = distinctTiles(region).length;
  switch (region.kind) {
    case "road":
      return { points: tiles, tiles, reason: `${tiles} tuile(s) × 1` };
    case "city": {
      const k = final ? 1 : 2;
      return { points: (tiles + region.shields) * k, tiles, reason: `${tiles} tuile(s) × ${k} + ${region.shields} blason(s) × ${k}` };
    }
    case "monastery": {
      const n = monasteryNeighbours(state, state.tiles[region.tiles[0]]);
      return final && n < 8 ? { points: 1 + n, tiles: 1 + n, reason: `abbaye + ${n} tuile(s) voisine(s)` } : { points: 9, tiles: 9, reason: "abbaye entourée de 8 tuiles" };
    }
    default: {
      const n = completedCitiesOfField(state, region).length;
      return { points: 3 * n, tiles, reason: `${n} cité(s) terminée(s) × 3` };
    }
  }
}

export function majority(region: Region, playerCount: number): { counts: number[]; winners: number[] } {
  const counts = new Array<number>(playerCount).fill(0);
  for (const m of region.meeples) counts[m.player]++;
  const max = Math.max(0, ...counts);
  const winners: number[] = [];
  if (max > 0) counts.forEach((c, i) => { if (c === max) winners.push(i); });
  return { counts, winners };
}

function settle(state: GameState, root: number, final: boolean): void {
  const region = state.regions.get(root)!;
  if (region.done) return;
  if (!final) region.done = true;
  if (region.meeples.length === 0) return;
  const { points, tiles, reason } = regionPoints(state, region, final);
  const { counts, winners } = majority(region, state.players.length);
  for (const w of winners) {
    const p = state.players[w];
    p.score += points;
    p.byKind[region.kind] += points;
    if (final) p.final += points; else p.duringGame += points;
  }
  const ev: ScoreEvent = {
    featureId: region.kind + ":" + root,
    featureType: region.kind,
    points,
    winningPlayerIds: winners.map((w) => state.config.players[w].id),
    tileCount: tiles,
    shieldCount: region.shields,
    reason: (final ? "Décompte final — " : "") + reason,
    final,
    turn: state.turn,
    meeples: counts,
    tiles: distinctTiles(region),
    node: root,
  };
  state.log.push(ev);
  if (!final) {
    // Every meeple goes home, including those of minority players.
    for (const m of region.meeples) state.players[m.player].meeples++;
    region.meeples = [];
  } else region.done = true;
}

function scoreCompleted(state: GameState): void {
  const tile = state.tiles[state.lastTile];
  const ix = topoIndex(tileTopology(tile));
  const roots = new Set<number>();
  for (let f = 0; f < ix.n; f++) {
    if (ix.kinds[f] !== "road" && ix.kinds[f] !== "city") continue;
    const r = find(state, tile.base + f);
    if (state.regions.get(r)!.open === 0) roots.add(r);
  }
  for (const r of [...roots].sort((a, b) => a - b)) settle(state, r, false);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const t = tileAt(state, tile.x + dx, tile.y + dy);
    if (!t) continue;
    const m = topoIndex(tileTopology(t)).monastery;
    if (m >= 0 && monasteryNeighbours(state, t) === 8) settle(state, find(state, t.base + m), false);
  }
}

function finalScoring(state: GameState): void {
  const roots = [...state.regions.keys()].sort((a, b) => a - b);
  for (const r of roots) {
    const region = state.regions.get(r)!;
    if (!region.done && region.meeples.length > 0) settle(state, r, true);
  }
}

// ---------------------------------------------------------------------------------------
// Turn machine
// ---------------------------------------------------------------------------------------
function draw(state: GameState): void {
  state.phase = TurnPhase.DRAW_TILE;
  state.current = null;
  state.lastTile = -1;
  for (;;) {
    const d = state.deck;
    if (d.total >= 0 && d.pos >= d.total) { finalScoring(state); state.phase = TurnPhase.GAME_OVER; return; }
    if (d.pos >= d.tiles.length) {
      if (d.total < 0 && d.secret !== undefined) d.tiles.push(sandboxTile(d.secret, d.pos, state.config.params));
      else return; // replica: wait for the host to reveal the next tile
    }
    const tile = d.tiles[d.pos++];
    if (hasLegalPlacement(state, tile)) { state.current = tile; state.phase = TurnPhase.PLACE_TILE; return; }
    state.discarded.push(tile); // unplaceable: discard and draw again
  }
}

function endTurn(state: GameState): void {
  state.phase = TurnPhase.SCORE_FEATURES;
  scoreCompleted(state);
  state.phase = TurnPhase.END_TURN;
  state.turn++;
  state.player = (state.player + 1) % state.players.length;
  draw(state);
}

export function cloneState(s: GameState): GameState {
  const regions = new Map<number, Region>();
  for (const [k, r] of s.regions) regions.set(k, { kind: r.kind, open: r.open, tiles: r.tiles.slice(), shields: r.shields, meeples: r.meeples.slice(), cities: r.cities.slice(), done: r.done });
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, byKind: { ...p.byKind } })),
    tiles: s.tiles.slice(),
    board: new Map(s.board),
    frontier: new Set(s.frontier),
    parent: s.parent.slice(),
    regions,
    deck: { ...s.deck },
    discarded: s.discarded.slice(),
    log: s.log.slice(),
  };
}

/** Validate an action without applying it. Returns an error message or "". */
export function validateAction(state: GameState, action: GameAction, playerIndex = state.player): string {
  if (state.phase === TurnPhase.GAME_OVER) return "La partie est terminée.";
  if (playerIndex !== state.player) return "Ce n'est pas le tour de ce joueur.";
  if (!action || typeof action !== "object") return "Action invalide.";
  switch (action.type) {
    case "PLACE_TILE":
      if (state.phase !== TurnPhase.PLACE_TILE || !state.current) return "Aucune tuile à placer maintenant.";
      if (![action.x, action.y, action.rotation].every(Number.isInteger) || action.rotation < 0 || action.rotation > 3 || Math.abs(action.x) > 30000 || Math.abs(action.y) > 30000) return "Coordonnées invalides.";
      if (!canPlace(state, state.current, action.x, action.y, action.rotation)) return "Placement illégal.";
      return "";
    case "PLACE_MEEPLE": {
      if (state.phase !== TurnPhase.PLACE_MEEPLE) return "Aucun partisan à poser maintenant.";
      const opt = meepleOptions(state).find((o) => o.regionId === action.regionId);
      if (!opt) return "Région inconnue sur cette tuile.";
      if (!opt.allowed) return opt.reason === "occupied" ? "Région déjà occupée." : opt.reason === "no-meeple" ? "Plus de partisan disponible." : "Les paysans sont désactivés.";
      return "";
    }
    case "SKIP_MEEPLE":
      return state.phase === TurnPhase.PLACE_MEEPLE ? "" : "Rien à passer maintenant.";
    case "END_GAME":
      if (state.config.mode !== "sandbox") return "Seul le bac à sable peut être terminé manuellement.";
      return state.phase === TurnPhase.PLACE_TILE ? "" : "Terminez d'abord le tour en cours.";
    default:
      return "Type d'action inconnu.";
  }
}

/** Apply a validated action by mutation (simulation fast path). Callers must validate first. */
export function applyUnchecked(state: GameState, action: GameAction): void {
  state.rev++;
  switch (action.type) {
    case "PLACE_TILE": {
      const p = state.players[state.player];
      state.lastTile = putTile(state, state.current!, action.x, action.y, action.rotation, state.player);
      state.current = null;
      p.tilesPlaced++;
      state.phase = TurnPhase.PLACE_MEEPLE;
      if (!meepleOptions(state).some((o) => o.allowed)) endTurn(state);
      break;
    }
    case "PLACE_MEEPLE": {
      const tile = state.tiles[state.lastTile];
      const m: Meeple = { player: state.player, tile: state.lastTile, feature: action.regionId };
      regionOf(state, tile.base + action.regionId).meeples.push(m);
      const p = state.players[state.player];
      p.meeples--;
      p.meeplesPlaced++;
      endTurn(state);
      break;
    }
    case "SKIP_MEEPLE":
      endTurn(state);
      break;
    case "END_GAME":
      state.current = null;
      finalScoring(state);
      state.phase = TurnPhase.GAME_OVER;
      break;
  }
}

/** Pure transition: the input state is never modified. */
export function applyAction(state: GameState, action: GameAction, playerIndex = state.player): ApplyResult {
  const error = validateAction(state, action, playerIndex);
  if (error) return { ok: false, error };
  const next = cloneState(state);
  applyUnchecked(next, action);
  return { ok: true, state: next };
}

/** Client replica: append tiles revealed by the host, then resume a pending draw. */
export function revealTiles(state: GameState, tiles: TileDef[]): GameState {
  const next = cloneState(state);
  next.deck.tiles = [...next.deck.tiles, ...tiles];
  if (next.phase === TurnPhase.DRAW_TILE) draw(next);
  return next;
}

// ---------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------
export interface CreateOptions {
  /** Secret used to build the deck (defaults to config.seed: fine for local games). */
  secret?: string;
  /** Pre-built deck (host) or revealed prefix (replica). */
  tiles?: TileDef[];
  total?: number;
  replica?: boolean;
}

export function validateConfig(config: GameConfig): string {
  if (!config || !Array.isArray(config.players)) return "Configuration invalide.";
  if (config.players.length < 2 || config.players.length > 5) return "Une partie se joue de 2 à 5 joueurs.";
  if (new Set(config.players.map((p) => p.id)).size !== config.players.length) return "Identifiants de joueurs en double.";
  if (!["classic", "procedural", "sandbox"].includes(config.mode)) return "Mode inconnu.";
  if (config.mode === "procedural" && !(config.deckSize >= 12 && config.deckSize <= 400)) return "Taille de deck entre 12 et 400.";
  return "";
}

export function createGame(config: GameConfig, opts: CreateOptions = {}): GameState {
  const bad = validateConfig(config);
  if (bad) throw new Error(bad);
  const secret = opts.secret ?? config.seed;
  const tiles = opts.tiles ?? buildDeck(config, secret);
  const total = opts.total ?? (config.mode === "sandbox" ? -1 : tiles.length);
  const players: PlayerState[] = config.players.map(() => ({
    score: 0, meeples: MEEPLES_PER_PLAYER, byKind: { city: 0, road: 0, field: 0, monastery: 0 },
    duringGame: 0, final: 0, tilesPlaced: 0, meeplesPlaced: 0,
  }));
  const state: GameState = {
    config, players, tiles: [], board: new Map(), frontier: new Set([cellKey(0, 0)]), parent: [], regions: new Map(),
    deck: { tiles, pos: 1, total }, replica: !!opts.replica, current: null, phase: TurnPhase.DRAW_TILE,
    player: 0, turn: 0, lastTile: -1, discarded: [], log: [], rev: 0,
  };
  if (total < 0 && !opts.replica) state.deck.secret = secret;
  putTile(state, tiles[0], 0, 0, 0, -1);
  draw(state);
  return state;
}

export function tilesRemaining(state: GameState): number {
  return state.deck.total < 0 ? -1 : state.deck.total - state.deck.pos;
}

// ---------------------------------------------------------------------------------------
// Public data, hashing, inspection
// ---------------------------------------------------------------------------------------
/** Everything every player is allowed to know, in canonical form (no hidden deck order). */
export function publicSummary(state: GameState): unknown {
  const meeples: number[][] = [];
  for (const r of state.regions.values()) for (const m of r.meeples) meeples.push([m.tile, m.feature, m.player]);
  meeples.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    tiles: state.tiles.map((t) => [t.def.topologyId, t.def.seed, t.x, t.y, t.rotation, t.by]),
    meeples,
    players: state.players.map((p) => [p.score, p.meeples, p.duringGame, p.final]),
    current: state.current ? [state.current.topologyId, state.current.seed] : null,
    phase: state.phase, player: state.player, turn: state.turn, pos: state.deck.pos, total: state.deck.total,
    discarded: state.discarded.length, rev: state.rev,
  };
}
export function stateHash(state: GameState): string {
  return sha256(canonicalJson(publicSummary(state)));
}

export interface RegionInfo {
  node: number; kind: FeatureKind; tiles: number[]; open: number; closed: boolean; scored: boolean;
  shields: number; meeples: number[]; winners: number[]; scoreNow: number; scoreFinal: number;
  reason: string; adjacentCities: { node: number; closed: boolean }[];
}
export function inspectRegion(state: GameState, tileIndex: number, feature: number): RegionInfo {
  const node = find(state, state.tiles[tileIndex].base + feature);
  const r = state.regions.get(node)!;
  const { counts, winners } = majority(r, state.players.length);
  const closed = r.kind === "monastery" ? monasteryNeighbours(state, state.tiles[r.tiles[0]]) === 8 : r.kind === "field" ? false : r.open === 0;
  const now = regionPoints(state, r, false), fin = regionPoints(state, r, true);
  const cityRoots = [...new Set(r.cities.map((c) => find(state, c)))];
  return {
    node, kind: r.kind, tiles: distinctTiles(r), open: r.open, closed, scored: r.done, shields: r.shields,
    meeples: counts, winners, scoreNow: closed || r.kind === "field" ? now.points : 0, scoreFinal: fin.points, reason: fin.reason,
    adjacentCities: cityRoots.map((c) => ({ node: c, closed: state.regions.get(c)!.open === 0 })),
  };
}

/** Ranking with shared places on equal scores (no invented tie-break). */
export function ranking(state: GameState): { player: number; score: number; rank: number }[] {
  const order = state.players.map((p, i) => ({ player: i, score: p.score, rank: 1 })).sort((a, b) => b.score - a.score || a.player - b.player);
  order.forEach((o, i) => { o.rank = i > 0 && order[i - 1].score === o.score ? order[i - 1].rank : i + 1; });
  return order;
}
