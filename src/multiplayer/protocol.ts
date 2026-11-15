/**
 * Wire protocol (JSON text frames over WebSocket). No image ever travels: tiles are
 * (topology id, seed) pairs and every peer regenerates geometry and artwork locally.
 */
import { PROTOCOL_VERSION } from "../core/types";
import type { TileDef } from "../core/types";
import type { BotLevel, DeckParams, GameAction, GameConfig, GameMode } from "../game/state";

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_SEATS = 5;

export interface SeatInfo {
  id: string;
  name: string;
  color: number;
  kind: "human" | "bot";
  level?: BotLevel;
  ready: boolean;
  connected: boolean;
  /** True when this seat is played from the host machine. */
  local: boolean;
}

export interface LobbySettings {
  mode: GameMode;
  deckSize: number;
  params: DeckParams;
  farmers: boolean;
  /** Replace a disconnected human by a bot while absent. */
  replaceAbsent: boolean;
}

export type ClientMessage =
  | { t: "hello"; v: number; name: string; sessionId?: string; token?: string }
  | { t: "ready"; ready: boolean; entropy: string }
  | { t: "color"; color: number }
  | { t: "action"; sessionId: string; playerId: string; seq: number; rev: number; action: GameAction }
  | { t: "resync" }
  | { t: "bye" };

export type HostMessage =
  | { t: "welcome"; v: number; sessionId: string; playerId: string; token: string; hostCommit: string }
  | { t: "lobby"; seats: SeatInfo[]; settings: LobbySettings }
  | { t: "start"; config: GameConfig; tiles: TileDef[]; total: number; deckCommit: string; entropies: string[] }
  | { t: "action"; rev: number; player: number; action: GameAction; reveal: TileDef[]; hash: string }
  | { t: "snapshot"; config: GameConfig; tiles: TileDef[]; total: number; actions: [number, GameAction][]; deckCommit: string; entropies: string[]; hash: string }
  | { t: "reject"; seq: number; reason: string; rev: number }
  | { t: "presence"; playerId: string; connected: boolean; bot: boolean }
  | { t: "reveal"; hostSecret: string; nonce: string; deck: [string, number][] }
  | { t: "error"; reason: string };

const isStr = (v: unknown, max = 200): v is string => typeof v === "string" && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const HEX = /^[0-9a-f]{0,128}$/;

/** Strict validation of untrusted client input. Returns null when malformed. */
export function parseClientMessage(text: string): ClientMessage | null {
  if (typeof text !== "string" || text.length > MAX_MESSAGE_BYTES) return null;
  let m: Record<string, unknown>;
  try { m = JSON.parse(text); } catch { return null; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  switch (m.t) {
    case "hello":
      if (!isInt(m.v) || !isStr(m.name, 24)) return null;
      if (m.sessionId !== undefined && !isStr(m.sessionId, 64)) return null;
      if (m.token !== undefined && !isStr(m.token, 64)) return null;
      return { t: "hello", v: m.v, name: m.name, sessionId: m.sessionId as string | undefined, token: m.token as string | undefined };
    case "ready":
      if (typeof m.ready !== "boolean" || !isStr(m.entropy, 128) || !HEX.test(m.entropy)) return null;
      return { t: "ready", ready: m.ready, entropy: m.entropy };
    case "color":
      return isInt(m.color) && m.color >= 0 && m.color < 8 ? { t: "color", color: m.color } : null;
    case "action": {
      if (!isStr(m.sessionId, 64) || !isStr(m.playerId, 64) || !isInt(m.seq) || !isInt(m.rev)) return null;
      const a = parseAction(m.action);
      return a ? { t: "action", sessionId: m.sessionId, playerId: m.playerId, seq: m.seq, rev: m.rev, action: a } : null;
    }
    case "resync": return { t: "resync" };
    case "bye": return { t: "bye" };
    default: return null;
  }
}

/** Whitelist the fields of an action (extra properties are dropped). */
export function parseAction(a: unknown): GameAction | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  switch (o.type) {
    case "PLACE_TILE": return isInt(o.x) && isInt(o.y) && isInt(o.rotation) ? { type: "PLACE_TILE", x: o.x, y: o.y, rotation: o.rotation } : null;
    case "PLACE_MEEPLE": return isInt(o.regionId) ? { type: "PLACE_MEEPLE", regionId: o.regionId } : null;
    case "SKIP_MEEPLE": return { type: "SKIP_MEEPLE" };
    case "END_GAME": return { type: "END_GAME" };
    default: return null;
  }
}

export function parseHostMessage(text: string): HostMessage | null {
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024) return null;
  try {
    const m = JSON.parse(text);
    return m && typeof m === "object" && typeof m.t === "string" ? (m as HostMessage) : null;
  } catch { return null; }
}

export { PROTOCOL_VERSION };

/**
 * LAN room code: a compact spelling of "IPv4:port" (base 36). It is only an address —
 * it works when the host is directly reachable (same network, or port forwarding).
 */
export function encodeRoomCode(ip: string, port: number): string {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return "";
  const n = ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
  return (n * 65536 + port).toString(36).toUpperCase();
}
export function decodeRoomCode(code: string): { ip: string; port: number } | null {
  if (!/^[0-9a-z]{1,11}$/i.test(code)) return null;
  const n = parseInt(code, 36);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  const port = n % 65536, a = Math.floor(n / 65536);
  if (a > 0xffffffff || port === 0) return null;
  return { ip: [Math.floor(a / 16777216), Math.floor(a / 65536) % 256, Math.floor(a / 256) % 256, a % 256].join("."), port };
}
