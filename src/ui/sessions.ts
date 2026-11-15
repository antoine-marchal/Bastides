/** Uniform view of a running game for the UI: local/hosted (authority here) or remote client. */
import { randomSeedString } from "../core/random";
import { TurnPhase } from "../game/state";
import type { GameAction, GameState } from "../game/state";
import { GameHost } from "../multiplayer/authority";
import type { HostTransport } from "../multiplayer/authority";
import { ClientSession } from "../multiplayer/session";
import type { Audit } from "../multiplayer/session";
import type { Recording } from "../persistence/serialization";
import type { BotService, NetServer } from "./platform";

export interface GameSession {
  readonly kind: "local" | "host" | "client";
  readonly state: GameState | null;
  onChange: (() => void) | null;
  /** A human sitting at this machine controls the active seat. */
  canAct(): boolean;
  act(action: GameAction): string;
  recording(): Recording | null;
  seatConnected(index: number): boolean;
  status(): string;
  audit(): Audit | null;
  leave(): void;
}

export class HostedSession implements GameSession {
  onChange: (() => void) | null = null;
  readonly host: GameHost;
  server: NetServer | null = null;
  constructor(private bots: BotService) {
    // The network server may be attached later (hosting): route through a proxy transport.
    const transport: HostTransport = {
      send: (conn, text) => this.server?.transport.send(conn, text),
      close: (conn) => this.server?.transport.close(conn),
    };
    this.host = new GameHost({ random: () => randomSeedString(), botRunner: bots.run, transport, onChange: () => this.onChange?.() });
  }
  get kind(): "local" | "host" { return this.server ? "host" : "local"; }
  get state(): GameState | null { return this.host.state; }
  canAct(): boolean {
    const s = this.host.state;
    if (!s || (s.phase !== TurnPhase.PLACE_TILE && s.phase !== TurnPhase.PLACE_MEEPLE)) return false;
    const seat = this.host.seats[s.player];
    return seat.local && seat.kind === "human";
  }
  act(action: GameAction): string {
    const s = this.host.state;
    return s ? this.host.submitLocal(this.host.seats[s.player].id, action) : "Aucune partie.";
  }
  recording(): Recording | null { return this.host.record; }
  seatConnected(i: number): boolean { return this.host.seats[i]?.connected ?? true; }
  status(): string {
    const s = this.host.state;
    if (!s) return "";
    if (this.host.activeBotLevel()) return "réflexion…";
    const seat = this.host.seats[s.player];
    return !seat.local && !seat.connected ? "en attente du joueur absent" : "";
  }
  audit(): Audit | null { return null; }
  leave(): void { this.host.shutdown(); this.bots.dispose(); void this.server?.stop(); }
}

export class RemoteSession implements GameSession {
  readonly kind = "client" as const;
  onChange: (() => void) | null = null;
  client: ClientSession;
  connected = false;
  closedByUser = false;
  private ws: WebSocket | null = null;
  private retry = 0;
  constructor(private url: string, name: string) {
    this.client = new ClientSession({ name, entropy: randomSeedString(), send: (t) => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(t); }, onChange: () => this.onChange?.() });
    this.connect();
  }
  private connect(): void {
    if (this.closedByUser) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.client.error = "Adresse invalide."; this.onChange?.(); return; }
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.retry = 0; this.client.onOpen(); this.onChange?.(); };
    ws.onmessage = (e) => { if (typeof e.data === "string") this.client.onMessage(e.data); };
    ws.onclose = () => {
      this.connected = false;
      this.onChange?.();
      // Reconnect with the session token while a game is running.
      if (!this.closedByUser && this.client.token && this.retry < 30) { this.retry++; setTimeout(() => this.connect(), 1500); }
      else if (!this.client.token && !this.client.error) { this.client.error = "Connexion impossible à l'hôte."; this.onChange?.(); }
    };
  }
  get state(): GameState | null { return this.client.state; }
  canAct(): boolean {
    const s = this.client.state;
    return !!s && this.connected && (s.phase === TurnPhase.PLACE_TILE || s.phase === TurnPhase.PLACE_MEEPLE) && s.player === this.client.myIndex();
  }
  act(action: GameAction): string { this.client.lastReject = ""; this.client.submit(action); return ""; }
  recording(): Recording | null {
    const s = this.client.state;
    return s ? { config: s.config, deck: s.deck.tiles.slice(0, s.deck.pos), total: s.deck.total, actions: this.client.actions } : null;
  }
  seatConnected(i: number): boolean {
    const id = this.client.state?.config.players[i]?.id;
    return this.client.seats.find((s) => s.id === id)?.connected ?? true;
  }
  status(): string { return this.connected ? "" : "connexion perdue — reconnexion…"; }
  audit(): Audit | null { return this.client.audit; }
  leave(): void { this.closedByUser = true; try { this.client.leave(); } catch { /* closed */ } this.ws?.close(); }
}
