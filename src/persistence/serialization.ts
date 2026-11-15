/**
 * Compact, versioned save format. A save stores LOGICAL data only: parameters, the deck
 * (topology id + seed per tile) and the action history. Board, regions, scores, masks and
 * images are rebuilt by replaying the actions through the engine, and the stored final
 * hash proves that the reconstruction matches.
 */
import { GENERATOR_VERSION, RULES_VERSION, SAVE_FORMAT_VERSION } from "../core/types";
import type { TileDef } from "../core/types";
import { canonicalJson } from "../core/hash";
import { catalog } from "../procedural/topology/catalog";
import { applyAction, createGame, stateHash, validateConfig } from "../game/gameEngine";
import type { GameAction, GameConfig, GameState } from "../game/state";
import { migrate } from "./migrations";

export interface SaveFile {
  format: number;
  rules: number;
  generator: number;
  app: "bastides";
  savedAt: string;
  name: string;
  config: GameConfig;
  /** Deck as [topologyId, seed] pairs: the whole deck for finite games, the drawn prefix for the sandbox. */
  deck: [string, number][];
  total: number;
  /** Secret of the endless sandbox generator (local games only). */
  secret?: string;
  /** Player index and action, in order. */
  actions: [number, GameAction][];
  /** Public hash of the state after the last action. */
  hash: string;
  /** Redundant summary for listings (never trusted when loading). */
  summary: { phase: string; turn: number; scores: number[]; tiles: number };
}

export class SaveError extends Error {}

export interface Recording {
  config: GameConfig;
  deck: TileDef[];
  total: number;
  secret?: string;
  actions: [number, GameAction][];
}

export function toSave(rec: Recording, state: GameState, name: string, savedAt: string): SaveFile {
  // The sandbox deck grows lazily: store what has been generated so far.
  const tiles = state.deck.total < 0 ? state.deck.tiles.slice(0, state.deck.pos) : rec.deck;
  return {
    format: SAVE_FORMAT_VERSION, rules: RULES_VERSION, generator: GENERATOR_VERSION, app: "bastides",
    savedAt, name, config: rec.config,
    deck: tiles.map((t) => [t.topologyId, t.seed]), total: rec.total, secret: rec.secret,
    actions: rec.actions, hash: stateHash(state),
    summary: { phase: state.phase, turn: state.turn, scores: state.players.map((p) => p.score), tiles: state.tiles.length },
  };
}

export function serializeSave(save: SaveFile): string {
  return canonicalJson(save);
}

const MAX_SAVE_BYTES = 4 * 1024 * 1024;

/** Parse and validate untrusted text (file import): data only, never evaluated as code. */
export function parseSave(text: string): SaveFile {
  if (typeof text !== "string" || text.length > MAX_SAVE_BYTES) throw new SaveError("Fichier de sauvegarde trop volumineux ou illisible.");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SaveError("Le fichier n'est pas un JSON valide."); }
  const save = migrate(raw);
  if (save.rules !== RULES_VERSION) throw new SaveError(`Sauvegarde créée avec les règles v${save.rules}, incompatible avec v${RULES_VERSION}.`);
  if (save.generator !== GENERATOR_VERSION) throw new SaveError(`Sauvegarde créée avec le générateur v${save.generator}; cette version utilise v${GENERATOR_VERSION} et produirait d'autres tuiles.`);
  const bad = validateConfig(save.config);
  if (bad) throw new SaveError("Configuration invalide : " + bad);
  if (!Array.isArray(save.deck) || save.deck.length < 1 || save.deck.length > 100000) throw new SaveError("Deck invalide.");
  const known = catalog();
  for (const t of save.deck) {
    if (!Array.isArray(t) || typeof t[0] !== "string" || !Number.isInteger(t[1]) || !known.has(t[0])) throw new SaveError("Tuile inconnue dans la sauvegarde.");
  }
  if (!Array.isArray(save.actions) || save.actions.length > 400000) throw new SaveError("Historique invalide.");
  return save;
}

export function recordingOf(save: SaveFile): Recording {
  return {
    config: save.config,
    deck: save.deck.map(([topologyId, seed]) => ({ topologyId, seed })),
    total: save.total,
    secret: save.secret,
    actions: save.actions,
  };
}

export function initialState(rec: Recording): GameState {
  const state = createGame(rec.config, { tiles: rec.deck.slice(), total: rec.total, secret: rec.secret });
  return state;
}

/** Rebuild the state after `upTo` actions (all by default). Throws SaveError on an illegal history. */
export function replay(rec: Recording, upTo = rec.actions.length): GameState {
  let state = initialState(rec);
  for (let i = 0; i < upTo; i++) {
    const [player, action] = rec.actions[i];
    const r = applyAction(state, action, player);
    if (!r.ok) throw new SaveError(`Historique incohérent à l'action ${i + 1} : ${r.error}`);
    state = r.state;
  }
  return state;
}

/** Load a save: replay it and check the stored hash. */
export function loadSave(save: SaveFile): { rec: Recording; state: GameState } {
  const rec = recordingOf(save);
  const state = replay(rec);
  if (stateHash(state) !== save.hash) throw new SaveError("La partie reconstruite ne correspond pas à l'empreinte enregistrée.");
  if (state.deck.total < 0 && rec.secret !== undefined) state.deck.secret = rec.secret;
  return { rec, state };
}
