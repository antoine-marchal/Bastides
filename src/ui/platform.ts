/**
 * Platform services: settings, synthesised sounds, save storage (Tauri commands or
 * localStorage), bot worker, native WebSocket host bridge.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { chooseTurn } from "../ai/bots";
import type { BotOptions, BotTurn } from "../ai/bots";
import type { GameState } from "../game/state";
import type { BotRunner, HostTransport } from "../multiplayer/authority";

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------- settings
export interface Settings { sound: boolean; autoCenter: boolean; showLegal: boolean; botDelay: number; name: string; perf: boolean; board3d: boolean;
  /** Table mode: side of the screen of each human seat of the last local set-up (0 bottom, 1 left, 2 top, 3 right). */
  tableSides: number[];
  /** Online relay server URL. */
  serverUrl: string }
const DEFAULTS: Settings = { sound: true, autoCenter: true, showLegal: true, botDelay: 600, name: "Joueur", perf: false, board3d: true, tableSides: [], serverUrl: "" };
export function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("bastides.settings") ?? "{}") }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s: Settings): void {
  try { localStorage.setItem("bastides.settings", JSON.stringify(s)); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- sound (Web Audio synthesis, no audio file)
let audio: AudioContext | null = null;
export function playSound(kind: "place" | "meeple" | "score" | "end", enabled: boolean): void {
  if (!enabled) return;
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    const note = (freq: number, at: number, dur: number, type: OscillatorType, gain: number) => {
      const o = audio!.createOscillator(), g = audio!.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t + at);
      g.gain.setValueAtTime(0, t + at); g.gain.linearRampToValueAtTime(gain, t + at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(audio!.destination); o.start(t + at); o.stop(t + at + dur + 0.02);
    };
    if (kind === "place") { note(150, 0, 0.12, "triangle", 0.22); note(90, 0.01, 0.16, "sine", 0.2); }
    else if (kind === "meeple") note(520, 0, 0.08, "triangle", 0.12);
    else if (kind === "score") { note(660, 0, 0.18, "sine", 0.12); note(880, 0.1, 0.26, "sine", 0.12); }
    else { note(523, 0, 0.3, "sine", 0.12); note(659, 0.15, 0.3, "sine", 0.12); note(784, 0.3, 0.5, "sine", 0.12); }
  } catch { /* audio unavailable */ }
}

// ---------------------------------------------------------------- save storage
export interface SaveStore {
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}
export function safeName(name: string): string {
  return name.normalize("NFD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "partie";
}
const PREFIX = "bastides.save.";
const browserStore: SaveStore = {
  async list() { return Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length)).sort(); },
  async read(name) { const v = localStorage.getItem(PREFIX + safeName(name)); if (v === null) throw new Error("Sauvegarde introuvable."); return v; },
  async write(name, text) { localStorage.setItem(PREFIX + safeName(name), text); },
  async remove(name) { localStorage.removeItem(PREFIX + safeName(name)); },
};
const tauriStore: SaveStore = {
  list: () => invoke<string[]>("save_list"),
  read: (name) => invoke<string>("save_read", { name: safeName(name) }),
  write: (name, text) => invoke<void>("save_write", { name: safeName(name), text }),
  remove: (name) => invoke<void>("save_delete", { name: safeName(name) }),
};
export const saveStore = (): SaveStore => (isTauri() ? tauriStore : browserStore);

// ---------------------------------------------------------------- bot worker
export interface BotService { run: BotRunner; dispose(): void; busy(): boolean }

export function createBotService(delay: () => number): BotService {
  let worker: Worker | null = null;
  let nextId = 1, pending = 0;
  const waiting = new Map<number, { resolve: (t: BotTurn) => void; reject: (e: Error) => void }>();
  const spawn = () => {
    worker = new Worker(new URL("../ai/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; turn?: BotTurn; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.turn) w.resolve(e.data.turn); else w.reject(new Error(e.data.error ?? "bot error"));
    };
    worker.onerror = () => { for (const w of waiting.values()) w.reject(new Error("worker error")); waiting.clear(); worker = null; };
  };
  const kill = () => { worker?.terminate(); worker = null; for (const w of waiting.values()) w.reject(new Error("cancelled")); waiting.clear(); };
  const run: BotRunner = async (view: GameState, opts: BotOptions) => {
    pending++;
    const started = performance.now();
    const full: BotOptions = { ...opts, simulations: 180, timeLimitMs: opts.level === "expert" ? 3500 : undefined };
    try {
      let turn: BotTurn;
      try {
        if (!worker) spawn();
        const id = nextId++;
        turn = await new Promise<BotTurn>((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          worker!.postMessage({ id, view, opts: full });
          // Hard cap for the user experience: restart the worker and let the host fall back.
          setTimeout(() => { if (waiting.has(id)) { kill(); reject(new Error("timeout")); } }, 20000);
        });
      } catch (err) {
        if ((err as Error).message === "cancelled" || (err as Error).message === "timeout") throw err;
        turn = chooseTurn(view, { ...full, level: opts.level === "expert" ? "hard" : opts.level }); // no Worker support: main thread
      }
      const wait = delay() - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return turn;
    } finally { pending--; }
  };
  return { run, dispose: kill, busy: () => pending > 0 };
}

// ---------------------------------------------------------------- native WebSocket host
export interface NetServer { port: number; addresses: string[]; transport: HostTransport; stop(): Promise<void> }
export interface NetHandlers { open(conn: number): void; message(conn: number, text: string): void; close(conn: number): void }

export function prepareNetwork(): Promise<string[]> {
  return isTauri() ? invoke<string[]>("net_prepare") : Promise.resolve([]);
}

export async function startNetServer(port: number, handlers: NetHandlers): Promise<NetServer> {
  if (!isTauri()) throw new Error("L’hébergement réseau nécessite l’application Bastides.");
  const local = await prepareNetwork();
  const unlisten = await listen<{ kind: string; conn: number; text?: string }>("net-event", (e) => {
    const p = e.payload;
    if (p.kind === "open") handlers.open(p.conn);
    else if (p.kind === "message") handlers.message(p.conn, p.text ?? "");
    else if (p.kind === "close") handlers.close(p.conn);
  });
  try {
    const info = await invoke<{ port: number; addresses: string[] }>("net_start", { port });
    return {
      ...info,
      addresses: local.length ? local : info.addresses,
      transport: {
        send: (conn, text) => { void invoke("net_send", { conn, text }).catch(() => {}); },
        close: (conn) => { void invoke("net_close", { conn }).catch(() => {}); },
      },
      stop: async () => { unlisten(); await invoke("net_stop").catch(() => {}); },
    };
  } catch (e) { unlisten(); throw e; }
}
