/** Uniform view of a running game for the UI: local/hosted (authority here) or remote client. */
import { randomSeedString } from "../core/random";
import { TurnPhase } from "../game/state";
import type { GameAction, GameState } from "../game/state";
import { GameHost } from "../multiplayer/authority";
import type { HostTransport } from "../multiplayer/authority";
import { ClientSession } from "../multiplayer/session";
import type { Audit } from "../multiplayer/session";
import { RelayHost, RelayLink } from "../multiplayer/relayClient";
import type { Recording } from "../persistence/serialization";
import type { BotService, NetServer } from "./platform";

/** Side of the screen a player sits at, in table mode: 0 bottom, 1 left, 2 top, 3 right. */
export type TableSide = 0 | 1 | 2 | 3;

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
  /** Table mode: where the human playing seat `index` sits around this screen, or null (not played here). */
  tableSide(index: number): TableSide | null;
  leave(): void;
}

export class HostedSession implements GameSession {
  onChange: (() => void) | null = null;
  readonly host: GameHost;
  server: NetServer | null = null;
  relay: RelayHost | null = null;
  /** Table-mode sides of the humans playing on this machine, by seat id. */
  sides = new Map<string, TableSide>();
  constructor(private bots: BotService) {
    // The network server may be attached later (hosting): route through a proxy transport.
    const transport: HostTransport = {
      send: (conn, text) => (this.relay?.transport ?? this.server?.transport)?.send(conn, text),
      close: (conn) => (this.relay?.transport ?? this.server?.transport)?.close(conn),
    };
    this.host = new GameHost({ random: () => randomSeedString(), botRunner: bots.run, transport, onChange: () => this.onChange?.() });
  }
  get kind(): "local" | "host" { return this.server || this.relay ? "host" : "local"; }
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
  /** Apply remembered sides (by seat index) to the humans of a resumed game. */
  useSides(sides: number[]): void {
    this.host.seats.forEach((seat, i) => { if (seat.local && seat.kind === "human") this.sides.set(seat.id, ((sides[i] ?? 0) & 3) as TableSide); });
  }
  tableSide(i: number): TableSide | null {
    const seat = this.host.seats[i];
    return seat && seat.local && seat.kind === "human" ? this.sides.get(seat.id) ?? 0 : null;
  }
  leave(): void {
    this.host.shutdown();
    this.bots.dispose();
    void this.server?.stop();
    // Let the shutdown frames leave before the room closes.
    const relay = this.relay;
    if (relay) setTimeout(() => void relay.stop(), 400);
  }
}

/** A guest's connection to the host: a LAN WebSocket or an online relay mailbox. */
export interface Link {
  onopen: (() => void) | null;
  onmessage: ((text: string) => void) | null;
  onclose: ((reason?: string, fatal?: boolean) => void) | null;
  send(text: string): void;
  close(): void;
}

export function webSocketLink(url: string): Link {
  const ws = new WebSocket(url);
  const link: Link = {
    onopen: null, onmessage: null, onclose: null,
    send: (t) => { if (ws.readyState === WebSocket.OPEN) ws.send(t); },
    close: () => ws.close(),
  };
  ws.onopen = () => link.onopen?.();
  ws.onmessage = (e) => { if (typeof e.data === "string") link.onmessage?.(e.data); };
  ws.onclose = () => link.onclose?.();
  return link;
}
export const relayLink = (server: string, room: string) => (): Link => new RelayLink(server, room);

export class RemoteSession implements GameSession {
  readonly kind = "client" as const;
  onChange: (() => void) | null = null;
  client: ClientSession;
  connected = false;
  closedByUser = false;
  private link: Link | null = null;
  private retry = 0;
  /** `label`: what the UI shows for the host (address or room code). */
  constructor(private connectLink: () => Link, name: string, readonly label: string) {
    this.client = new ClientSession({ name, entropy: randomSeedString(), send: (t) => this.link?.send(t), onChange: () => this.onChange?.() });
    this.connect();
  }
  private connect(): void {
    if (this.closedByUser) return;
    let link: Link;
    try { link = this.connectLink(); } catch { this.client.error = "Adresse invalide."; this.onChange?.(); return; }
    this.link = link;
    link.onopen = () => { this.connected = true; this.retry = 0; this.client.onOpen(); this.onChange?.(); };
    link.onmessage = (t) => this.client.onMessage(t);
    link.onclose = (reason, fatal) => {
      if (this.link !== link) return;
      this.connected = false;
      // Reconnect with the session token while a game is running.
      if (!this.closedByUser && !fatal && !this.client.error && this.client.token && this.retry < 30) { this.retry++; setTimeout(() => this.connect(), 1500); }
      else if (!this.closedByUser && !this.client.error) this.client.error = reason || (this.client.token ? "Connexion perdue avec l'hôte." : "Connexion impossible à l'hôte.");
      this.onChange?.();
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
  tableSide(): TableSide | null { return null; }
  leave(): void { this.closedByUser = true; try { this.client.leave(); } catch { /* closed */ } const l = this.link; setTimeout(() => l?.close(), 300); }
}
