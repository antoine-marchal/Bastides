/**
 * Client side of the online relay (see server/src/relay.js): HTTP long-polling mailboxes.
 * The relay only carries text frames; the hosting app stays authoritative (GameHost).
 *
 *  - RelayHost: the host's end. Creates a room, turns mailbox events into
 *    onConnect / onMessage / onDisconnect and offers a HostTransport.
 *  - RelayLink: a guest's end, shaped like a WebSocket (open / message / close).
 */
import type { HostTransport } from "./authority";

export const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

/** "relay.example.app" -> "https://relay.example.app" (http kept for localhost). */
export function normalizeServerUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\]|192\.168\.|10\.)/i.test(s) ? "http://" : "https://") + s;
  try { const u = new URL(s); return u.origin + u.pathname.replace(/\/+$/, ""); } catch { return ""; }
}
export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try { res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } }); }
  catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new RelayError(0, "Serveur injoignable. Vérifiez l'adresse et votre connexion.");
  }
  let body: { error?: string } & Record<string, unknown> = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new RelayError(res.status, body.error ?? `Erreur du serveur (${res.status}).`);
  return body as T;
}
export class RelayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const post = <T>(url: string, body: unknown) => call<T>(url, { method: "POST", body: JSON.stringify(body) });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Check that the URL answers like a Bastides relay. */
export async function probeServer(server: string): Promise<string> {
  const r = await call<{ service?: string; store?: string }>(server + "/health");
  if (r.service !== "bastides-relay") throw new RelayError(0, "Cette adresse ne répond pas comme un serveur Bastides.");
  return r.store ?? "";
}

type Event = { k: "open" | "message" | "close"; conn?: number; text?: string; reason?: string };

/** Ordered, batched sender: one request in flight at a time keeps frames in order. */
class Outbox<F> {
  private queue: F[] = [];
  private flushing = false;
  constructor(private deliver: (frames: F[]) => Promise<void>, private onFatal: (e: RelayError) => void) {}
  push(f: F): void { this.queue.push(f); if (!this.flushing) queueMicrotask(() => void this.flush()); }
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, 48);
        try { await this.deliver(batch); this.queue.splice(0, batch.length); }
        catch (e) {
          if (e instanceof RelayError && e.status >= 400 && e.status < 500) { this.queue = []; this.onFatal(e); return; }
          await pause(1000); // transient: retry the same batch
        }
      }
    } finally { this.flushing = false; }
  }
}

/** Long-poll loop over one mailbox. */
function pollLoop(url: () => string, onEvents: (evs: Event[]) => boolean, onFatal: (e: RelayError) => void): () => void {
  let stopped = false, after = 0, failures = 0;
  const ac = new AbortController();
  void (async () => {
    while (!stopped) {
      try {
        const r = await call<{ events: Event[]; next: number; closed?: boolean }>(`${url()}&after=${after}`, { signal: ac.signal });
        failures = 0;
        after = r.next;
        if (!onEvents(r.events) || r.closed) { stopped = true; return; }
      } catch (e) {
        if (stopped) return;
        if (e instanceof RelayError && e.status >= 400 && e.status < 500) { stopped = true; onFatal(e); return; }
        failures++;
        await pause(Math.min(8000, 500 * failures));
      }
    }
  })();
  return () => { stopped = true; ac.abort(); };
}

export interface RelayHandlers { open(conn: number): void; message(conn: number, text: string): void; close(conn: number): void }

export class RelayHost {
  readonly transport: HostTransport;
  private stopPoll: () => void = () => {};
  private outbox: Outbox<{ to: number; text: string; close?: boolean }>;
  onFatal: ((message: string) => void) | null = null;

  private constructor(readonly server: string, readonly room: string, private key: string, handlers: RelayHandlers) {
    const base = `${server}/rooms/${room}`;
    this.outbox = new Outbox((frames) => post(base + "/send", { key, frames }).then(() => {}), (e) => this.onFatal?.(e.message));
    this.transport = {
      send: (conn, text) => this.outbox.push({ to: conn, text }),
      // Closing a guest: the relay delivers a "close" right after its pending frames.
      close: (conn) => this.outbox.push({ to: conn, text: "", close: true }),
    };
    this.stopPoll = pollLoop(() => `${base}/poll?key=${key}`, (evs) => {
      for (const e of evs) {
        if (e.conn === undefined) continue;
        if (e.k === "open") handlers.open(e.conn);
        else if (e.k === "message") handlers.message(e.conn, e.text ?? "");
        else if (e.k === "close") handlers.close(e.conn);
      }
      return true;
    }, (e) => this.onFatal?.(e.message));
  }

  static async open(server: string, handlers: RelayHandlers): Promise<RelayHost> {
    await probeServer(server);
    const r = await post<{ room: string; key: string }>(server + "/rooms", {});
    return new RelayHost(server, r.room, r.key, handlers);
  }

  async stop(): Promise<void> {
    this.stopPoll();
    await post(`${this.server}/rooms/${this.room}/leave`, { key: this.key }).catch(() => {});
  }
}

/** A guest's connection, with the subset of the WebSocket interface the session uses. */
export class RelayLink {
  onopen: (() => void) | null = null;
  onmessage: ((text: string) => void) | null = null;
  /** `fatal`: the room is gone or refuses us — reconnecting is pointless. */
  onclose: ((reason?: string, fatal?: boolean) => void) | null = null;
  private key = "";
  private stopPoll: () => void = () => {};
  private outbox: Outbox<string>;
  private closed = false;

  constructor(private server: string, private room: string) {
    const base = `${server}/rooms/${room}`;
    this.outbox = new Outbox((frames) => post(base + "/send", { key: this.key, frames }).then(() => {}), (e) => this.finish(e.message));
    void this.connect(base);
  }
  private async connect(base: string): Promise<void> {
    let r: { conn: number; key: string };
    try { r = await post(base + "/join", {}); }
    catch (e) { const fatal = e instanceof RelayError && e.status >= 400 && e.status < 500; this.finish(e instanceof RelayError ? e.message : undefined, fatal); return; }
    if (this.closed) { void post(base + "/leave", { key: r.key }).catch(() => {}); return; }
    this.key = r.key;
    this.stopPoll = pollLoop(() => `${base}/poll?key=${this.key}`, (evs) => {
      for (const e of evs) {
        if (e.k === "message") this.onmessage?.(e.text ?? "");
        else if (e.k === "close") { this.finish(e.reason || "Connexion fermée."); return false; }
      }
      return true;
    }, (e) => this.finish(e.message));
    this.onopen?.();
  }
  get open(): boolean { return !!this.key && !this.closed; }
  send(text: string): void { if (this.open) this.outbox.push(text); }
  private finish(reason?: string, fatal = false): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPoll();
    this.onclose?.(reason, fatal);
  }
  close(): void {
    if (this.closed) return;
    const key = this.key;
    this.closed = true;
    this.stopPoll();
    if (key) void post(`${this.server}/rooms/${this.room}/leave`, { key }).catch(() => {});
  }
}
