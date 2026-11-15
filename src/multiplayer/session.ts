/**
 * Network client. It keeps a replica of the PUBLIC state by applying the host's validated
 * actions through the same engine, checks the host's state hash after each one, asks for a
 * snapshot on divergence, and audits the deck commitment when the host reveals it.
 */
import type { TileDef } from "../core/types";
import { canonicalJson, sha256 } from "../core/hash";
import { buildDeck, sandboxTile } from "../game/deck";
import { applyAction, cloneState, createGame, stateHash } from "../game/gameEngine";
import type { GameAction, GameConfig, GameState } from "../game/state";
import { PROTOCOL_VERSION, parseHostMessage } from "./protocol";
import type { ClientMessage, HostMessage, LobbySettings, SeatInfo } from "./protocol";

export type Audit = { status: "pending" } | { status: "verified" } | { status: "failed"; reason: string };

export interface ClientOptions {
  send: (text: string) => void;
  name: string;
  /** This peer's contribution to the deck entropy (hex). */
  entropy: string;
  onChange?: () => void;
  /** Resume an earlier session after a disconnection. */
  resume?: { sessionId: string; token: string; playerId: string };
}

export class ClientSession {
  state: GameState | null = null;
  seats: SeatInfo[] = [];
  settings: LobbySettings | null = null;
  playerId = "";
  sessionId = "";
  token = "";
  hostCommit = "";
  deckCommit = "";
  entropies: string[] = [];
  error = "";
  lastReject = "";
  audit: Audit = { status: "pending" };
  /** Number of resynchronisations requested after a detected divergence. */
  resyncs = 0;
  actions: [number, GameAction][] = [];
  private seq = 0;
  private pending = new Map<number, Extract<HostMessage, { t: "action" }>>();
  private awaitingSnapshot = false;

  constructor(private opts: ClientOptions) {
    if (opts.resume) { this.sessionId = opts.resume.sessionId; this.token = opts.resume.token; this.playerId = opts.resume.playerId; }
  }

  private send(m: ClientMessage): void { this.opts.send(JSON.stringify(m)); }

  /** Call when the socket opens (also after a reconnection). */
  onOpen(): void {
    this.error = "";
    this.send(this.token ? { t: "hello", v: PROTOCOL_VERSION, name: this.opts.name, sessionId: this.sessionId, token: this.token } : { t: "hello", v: PROTOCOL_VERSION, name: this.opts.name });
  }

  setReady(ready: boolean): void { this.send({ t: "ready", ready, entropy: this.opts.entropy }); }
  setColor(color: number): void { this.send({ t: "color", color }); }
  leave(): void { this.send({ t: "bye" }); }

  myIndex(): number { return this.state ? this.state.config.players.findIndex((p) => p.id === this.playerId) : -1; }

  /** Send an intention; the replica only changes when the host echoes the validated action. */
  submit(action: GameAction): void {
    if (!this.state) return;
    this.send({ t: "action", sessionId: this.sessionId, playerId: this.playerId, seq: ++this.seq, rev: this.state.rev, action });
  }

  onMessage(text: string): void {
    const m = parseHostMessage(text);
    if (!m) return;
    switch (m.t) {
      case "welcome":
        if (m.v !== PROTOCOL_VERSION) { this.error = "Version de protocole incompatible."; break; }
        this.sessionId = m.sessionId; this.playerId = m.playerId; this.token = m.token; this.hostCommit = m.hostCommit;
        break;
      case "lobby":
        this.seats = m.seats; this.settings = m.settings;
        break;
      case "start":
        this.begin(m.config, m.tiles, m.total, m.deckCommit, m.entropies);
        break;
      case "snapshot":
        this.begin(m.config, m.tiles, m.total, m.deckCommit, m.entropies);
        for (const [player, action] of m.actions) {
          const r = applyAction(this.state!, action, player);
          if (!r.ok) { this.error = "Instantané incohérent : " + r.error; return; }
          this.state = r.state;
        }
        this.actions = m.actions.slice();
        this.awaitingSnapshot = false;
        if (stateHash(this.state!) !== m.hash) this.error = "L'instantané de l'hôte ne correspond pas à son empreinte.";
        break;
      case "action":
        this.onAction(m);
        break;
      case "reject":
        this.lastReject = m.reason;
        if (this.state && m.rev !== this.state.rev && this.pending.size === 0) this.requestResync();
        break;
      case "presence": {
        const seat = this.seats.find((s) => s.id === m.playerId);
        if (seat) seat.connected = m.connected;
        break;
      }
      case "reveal":
        this.audit = this.verify(m.hostSecret, m.nonce, m.deck);
        break;
      case "error":
        this.error = m.reason;
        break;
    }
    this.opts.onChange?.();
  }

  private begin(config: GameConfig, tiles: TileDef[], total: number, deckCommit: string, entropies: string[]): void {
    this.state = createGame(config, { tiles: tiles.slice(), total, replica: true });
    this.deckCommit = deckCommit;
    this.entropies = entropies;
    this.actions = [];
    this.pending.clear();
    this.audit = entropies.includes(this.opts.entropy) || !this.opts.entropy ? { status: "pending" } : { status: "failed", reason: "Votre contribution d'entropie n'a pas été prise en compte." };
  }

  private requestResync(): void {
    if (this.awaitingSnapshot) return;
    this.awaitingSnapshot = true;
    this.resyncs++;
    this.pending.clear();
    this.send({ t: "resync" });
  }

  private onAction(m: Extract<HostMessage, { t: "action" }>): void {
    if (!this.state || this.awaitingSnapshot) return;
    if (m.rev <= this.state.rev) return; // duplicate
    this.pending.set(m.rev, m); // out-of-order frames wait for their turn
    for (;;) {
      const next = this.pending.get(this.state.rev + 1);
      if (!next) break;
      this.pending.delete(next.rev);
      const s = cloneState(this.state);
      s.deck.tiles = s.deck.tiles.concat(next.reveal);
      const r = applyAction(s, next.action, next.player);
      if (!r.ok || stateHash(r.state) !== next.hash) { this.requestResync(); return; } // divergence
      this.state = r.state;
      this.actions.push([next.player, next.action]);
    }
    if (this.pending.size > 64) this.requestResync();
  }

  /** Audit of the commitment once the host opens it. */
  private verify(hostSecret: string, nonce: string, deck: [string, number][]): Audit {
    const s = this.state;
    if (!s) return { status: "failed", reason: "Aucune partie." };
    if (sha256(hostSecret) !== this.hostCommit) return { status: "failed", reason: "Le secret de l'hôte ne correspond pas à son engagement initial." };
    if (s.deck.total >= 0 && sha256(nonce + "|" + canonicalJson(deck)) !== this.deckCommit) return { status: "failed", reason: "Le deck révélé ne correspond pas à l'engagement publié avant la partie." };
    const drawn = s.deck.tiles.slice(0, s.deck.pos);
    for (let i = 0; i < drawn.length; i++) {
      if (!deck[i] || deck[i][0] !== drawn[i].topologyId || deck[i][1] !== drawn[i].seed) return { status: "failed", reason: `La tuile n°${i + 1} tirée diffère du deck engagé.` };
    }
    const secret = sha256(hostSecret + "|" + this.entropies.join("|"));
    if (s.config.seed !== sha256(secret + "/public").slice(0, 16)) return { status: "failed", reason: "La graine publique ne dérive pas des contributions des joueurs." };
    const expected = s.deck.total >= 0 ? buildDeck(s.config, secret) : deck.map((_, i) => sandboxTile(secret, i, s.config.params));
    if (expected.length !== deck.length || expected.some((t, i) => t.topologyId !== deck[i][0] || t.seed !== deck[i][1])) return { status: "failed", reason: "Le deck n'a pas été généré à partir de l'entropie commune." };
    return { status: "verified" };
  }
}
