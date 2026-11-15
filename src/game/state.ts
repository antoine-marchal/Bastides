/** Game state model. Pure data: serialisable, clonable, no DOM/Canvas/network dependency. */
import type { FeatureKind, TileDef } from "../core/types";

export enum TurnPhase {
  DRAW_TILE = "DRAW_TILE",
  PLACE_TILE = "PLACE_TILE",
  PLACE_MEEPLE = "PLACE_MEEPLE",
  SCORE_FEATURES = "SCORE_FEATURES",
  END_TURN = "END_TURN",
  GAME_OVER = "GAME_OVER",
}

export type BotLevel = "easy" | "normal" | "hard" | "expert";
export type GameMode = "classic" | "procedural" | "sandbox";

export interface PlayerConfig {
  id: string;
  name: string;
  /** Index in the UI palette. */
  color: number;
  kind: "human" | "bot";
  level?: BotLevel;
}

/** Procedural deck knobs; 1 = neutral. */
export interface DeckParams {
  cityDensity: number;
  roadDensity: number;
  grassDensity: number;
  monasteryFreq: number;
  shieldFreq: number;
  junctionFreq: number;
  throughCityFreq: number;
  complexity: number;
  diversity: number;
}
export const DEFAULT_DECK_PARAMS: DeckParams = {
  cityDensity: 1, roadDensity: 1, grassDensity: 1, monasteryFreq: 1, shieldFreq: 1,
  junctionFreq: 1, throughCityFreq: 1, complexity: 1, diversity: 1,
};

export interface GameConfig {
  mode: GameMode;
  /** Total number of tiles, starting tile included (ignored in sandbox). */
  deckSize: number;
  params: DeckParams;
  farmers: boolean;
  players: PlayerConfig[];
  /** Public identifier of the game. The secret deck order is NOT derivable from it in network games. */
  seed: string;
}

export const MEEPLES_PER_PLAYER = 7;

export type GameAction =
  | { type: "PLACE_TILE"; x: number; y: number; rotation: number }
  | { type: "PLACE_MEEPLE"; regionId: number }
  | { type: "SKIP_MEEPLE" }
  | { type: "END_GAME" };

export interface PlacedTile {
  def: TileDef;
  x: number;
  y: number;
  rotation: number;
  /** Global node id of local feature 0; feature f is node base + f. */
  base: number;
  /** Player index who placed it (-1 for the starting tile). */
  by: number;
}

export interface Meeple {
  player: number;
  /** Index of the placed tile and local feature the meeple stands on. */
  tile: number;
  feature: number;
}

export interface Region {
  kind: FeatureKind;
  /** Number of unmatched main interfaces (roads, cities). */
  open: number;
  /** Tile indices of every member segment (may contain duplicates; score on the distinct set). */
  tiles: number[];
  shields: number;
  meeples: Meeple[];
  /** Fields only: node ids of adjacent city segments (resolved through find() when scoring). */
  cities: number[];
  /** Completed and settled (meeples returned). */
  done: boolean;
}

export interface PlayerState {
  score: number;
  meeples: number;
  byKind: Record<FeatureKind, number>;
  duringGame: number;
  final: number;
  tilesPlaced: number;
  meeplesPlaced: number;
}

export interface ScoreEvent {
  featureId: string;
  featureType: FeatureKind;
  points: number;
  winningPlayerIds: string[];
  tileCount: number;
  shieldCount: number;
  reason: string;
  final: boolean;
  turn: number;
  /** Per player index: meeples that were on the feature. */
  meeples: number[];
  /** Tile indices of the feature (for highlighting). */
  tiles: number[];
  /** Root node of the region when scored. */
  node: number;
}

export interface DeckState {
  /** Host: whole deck. Client replica: the prefix revealed so far. */
  tiles: TileDef[];
  /** Index of the next tile to draw. */
  pos: number;
  /** Total number of tiles; -1 for the endless sandbox. */
  total: number;
  /** Host-only secret of the endless sandbox generator (never sent to clients). */
  secret?: string;
  /** Public views only: sorted multiset of the unseen tiles (their order is unknown). */
  pool?: TileDef[];
}

export interface GameState {
  config: GameConfig;
  players: PlayerState[];
  tiles: PlacedTile[];
  /** cellKey -> index in tiles (sparse board). */
  board: Map<number, number>;
  /** Empty cells orthogonally adjacent to at least one tile. */
  frontier: Set<number>;
  /** Union-find forest over feature nodes (union by size, no path compression: reads are pure). */
  parent: number[];
  /** Root node -> region. */
  regions: Map<number, Region>;
  deck: DeckState;
  /** True for client replicas that cannot draw by themselves. */
  replica: boolean;
  current: TileDef | null;
  phase: TurnPhase;
  /** Index of the active player. */
  player: number;
  /** Number of completed turns. */
  turn: number;
  /** Index of the tile placed during the current turn, or -1. */
  lastTile: number;
  discarded: TileDef[];
  log: ScoreEvent[];
  /** Number of actions applied (revision used by the network protocol). */
  rev: number;
}

export type ApplyResult = { ok: true; state: GameState } | { ok: false; error: string };
