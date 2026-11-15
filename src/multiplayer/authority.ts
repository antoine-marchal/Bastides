/**
 * Authoritative host. It owns the reference state and the secret deck, validates every
 * intention with the same engine validators used locally, and broadcasts validated
 * actions with the tiles they reveal. The same class runs purely local games (no client).
 *
 * Transport-agnostic: connections are opaque numbers; text goes through `transport`.
 */
import type { TileDef } from "../core/types";
import { canonicalJson, sha256 } from "../core/hash";
import { botSeedKey, fallbackTurn, turnActions } from "../ai/bots";
import type { BotOptions, BotTurn } from "../ai/bots";
import { publicView } from "../ai/view";
import { buildDeck } from "../game/deck";
import { applyAction, createGame, stateHash, validateConfig } from "../game/gameEngine";
import { DEFAULT_DECK_PARAMS, TurnPhase } from "../game/state";
import type { BotLevel, GameAction, GameConfig, GameState } from "../game/state";
import type { Recording } from "../persistence/serialization";
import { MAX_MESSAGE_BYTES, MAX_SEATS, PROTOCOL_VERSION, parseClientMessage } from "./protocol";
import type { HostMessage, LobbySettings, SeatInfo } from "./protocol";

export interface HostTransport {
  send(conn: number, text: string): void;
  close(conn: number): void;
}
export type BotRunner = (view: GameState, opts: BotOptions) => Promise<BotTurn>;

interface Seat extends SeatInfo {
  conn: number | null;
  token: string;
  entropy: string;
  lastSeq: number;
}

export interface HostOptions {
  transport?: HostTransport;
  /** Fresh unpredictable hex strings (crypto.getRandomValues in production). */
  random: () => string;
  botRunner: BotRunner;
  onChange?: () => void;
  settings?: Partial<LobbySettings>;
}

const RATE_PER_SECOND = 40;

export class GameHost {
  readonly sessionId: string;
  readonly hostSecret: string;
  readonly hostCommit: string;
  seats: Seat[] = [];
  settings: LobbySettings;
  state: GameState | null = null;
  record: Recording | null = null;
  deckCommit = "";
  private nonce = "";
  private fullDeck: TileDef[] = [];
  private entropies: string[] = [];
  private conns = new Map<number, { seat: Seat | null; count: number; windowStart: number }>();
  private botEpoch = 0;
  private revealed = false;
  private nextId = 0;
  private transport: HostTransport;
  /** Messages rejected, for diagnostics and tests. */
  rejected = 0;

  constructor(private opts: HostOptions) {
    this.transport = opts.transport ?? { send() {}, close() {} };
    this.sessionId = opts.random().slice(0, 16);
    this.hostSecret = opts.random();
    this.hostCommit = sha256(this.hostSecret);
    this.settings = { mode: "classic", deckSize: 72, params: { ...DEFAULT_DECK_PARAMS }, farmers: true, replaceAbsent: true, ...opts.settings };
  }

  // ------------------------------------------------------------------ lobby (host side)
  private freeColor(): number {
    for (let c = 0; c < 8; c++) if (!this.seats.some((s) => s.color === c)) return c;
    return 0;
  }
  private newSeat(name: string, kind: "human" | "bot", local: boolean, level?: BotLevel): Seat | null {
    if (this.seats.length >= MAX_SEATS || this.state) return null;
    const seat: Seat = { id: "s" + this.nextId++, name: name.slice(0, 24) || "Joueur", color: this.freeColor(), kind, level, ready: kind === "bot" || local, connected: true, local, conn: null, token: this.opts.random(), entropy: "", lastSeq: 0 };
    this.seats.push(seat);
    return seat;
  }
  addLocalPlayer(name: string): string | null { const s = this.newSeat(name, "human", true); this.lobbyChanged(); return s?.id ?? null; }
  addBot(level: BotLevel, name?: string): string | null {
    const label = { easy: "Facile", normal: "Normal", hard: "Difficile", expert: "Expert" }[level];
    const s = this.newSeat(name ?? `Bot ${label}`, "bot", true, level);
    this.lobbyChanged();
    return s?.id ?? null;
  }
  removeSeat(id: string): void {
    if (this.state) return;
    const seat = this.seats.find((s) => s.id === id);
    if (!seat) return;
    if (seat.conn !== null) { this.sendTo(seat.conn, { t: "error", reason: "Vous avez été retiré de la partie." }); this.transport.close(seat.conn); this.conns.delete(seat.conn); }
    this.seats = this.seats.filter((s) => s !== seat);
    this.lobbyChanged();
  }
  updateSeat(id: string, patch: Partial<Pick<SeatInfo, "name" | "color" | "level">>): void {
    const seat = this.seats.find((s) => s.id === id);
    if (!seat || this.state) return;
    if (patch.name !== undefined) seat.name = patch.name.slice(0, 24);
    if (patch.color !== undefined && !this.seats.some((s) => s !== seat && s.color === patch.color)) seat.color = patch.color;
    if (patch.level !== undefined && seat.kind === "bot") seat.level = patch.level;
    this.lobbyChanged();
  }
  updateSettings(patch: Partial<LobbySettings>): void {
    if (this.state) return;
    this.settings = { ...this.settings, ...patch };
    this.lobbyChanged();
  }
  seatInfos(): SeatInfo[] {
    return this.seats.map(({ id, name, color, kind, level, ready, connected, local }) => ({ id, name, color, kind, level, ready, connected, local }));
  }
  private lobbyChanged(): void {
    this.broadcast({ t: "lobby", seats: this.seatInfos(), settings: this.settings });
    this.opts.onChange?.();
  }
  canStart(): string {
    if (this.state) return "La partie a déjà commencé.";
    if (this.seats.length < 2) return "Il faut au moins deux joueurs.";
    if (this.seats.some((s) => !s.ready)) return "Tous les joueurs ne sont pas prêts.";
    return "";
  }

  /** Start the game. `seed` forces a reproducible local game; network games mix every peer's entropy. */
  start(seed?: string): string {
    const why = this.canStart();
    if (why) return why;
    this.entropies = this.seats.filter((s) => !s.local).map((s) => s.entropy).sort();
    const secret = seed ?? sha256(this.hostSecret + "|" + this.entropies.join("|"));
    const config: GameConfig = {
      mode: this.settings.mode, deckSize: this.settings.deckSize, params: this.settings.params, farmers: this.settings.farmers,
      players: this.seats.map((s) => ({ id: s.id, name: s.name, color: s.color, kind: s.kind, level: s.level })),
      // Public game id: reveals nothing about the deck order of a network game.
      seed: seed ?? sha256(secret + "/public").slice(0, 16),
    };
    const bad = validateConfig(config);
    if (bad) return bad;
    const deck = buildDeck(config, secret);
    this.fullDeck = deck;
    this.nonce = this.opts.random();
    this.deckCommit = sha256(this.nonce + "|" + canonicalJson(deck.map((t) => [t.topologyId, t.seed])));
    this.state = createGame(config, { tiles: deck.slice(), secret });
    this.record = { config, deck, total: this.state.deck.total, secret: config.mode === "sandbox" ? secret : undefined, actions: [] };
    const s = this.state;
    this.broadcast({ t: "start", config, tiles: s.deck.tiles.slice(0, s.deck.pos), total: s.deck.total, deckCommit: this.deckCommit, entropies: this.entropies });
    this.afterChange();
    return "";
  }

  /** Resume a saved local game. */
  resume(rec: Recording, state: GameState): void {
    this.record = { ...rec, actions: rec.actions.slice() };
    this.state = state;
    this.fullDeck = rec.deck;
    this.seats = rec.config.players.map((p, i) => ({ id: p.id, name: p.name, color: p.color, kind: p.kind, level: p.level, ready: true, connected: true, local: true, conn: null, token: this.opts.random(), entropy: "", lastSeq: 0 }));
    this.settings = { ...this.settings, mode: rec.config.mode, deckSize: rec.config.deckSize, params: rec.config.params, farmers: rec.config.farmers };
    this.afterChange();
  }

  // ------------------------------------------------------------------ actions
  /** Intention from a player sitting at the host machine. Returns "" or the refusal reason. */
  submitLocal(playerId: string, action: GameAction): string {
    const idx = this.seats.findIndex((s) => s.id === playerId);
    if (idx < 0 || !this.seats[idx].local || this.seats[idx].kind !== "human") return "Ce joueur n'est pas contrôlé ici.";
    return this.apply(idx, action);
  }

  private apply(player: number, action: GameAction): string {
    const state = this.state;
    if (!state) return "La partie n'a pas commencé.";
    const before = state.deck.pos;
    const r = applyAction(state, action, player);
    if (!r.ok) return r.error;
    this.state = r.state;
    this.record!.actions.push([player, action]);
    const reveal = r.state.deck.tiles.slice(before, r.state.deck.pos);
    this.broadcast({ t: "action", rev: r.state.rev, player, action, reveal, hash: stateHash(r.state) });
    this.afterChange();
    return "";
  }

  private afterChange(): void {
    const s = this.state!;
    this.botEpoch++;
    if (s.phase === TurnPhase.GAME_OVER) this.reveal();
    else this.maybeRunBot();
    this.opts.onChange?.();
  }

  /** After the game: open the commitment so that every client can audit the deck. */
  private reveal(): void {
    if (this.revealed) return;
    this.revealed = true;
    const deck = (this.state!.deck.total < 0 ? this.state!.deck.tiles : this.fullDeck).map((t) => [t.topologyId, t.seed] as [string, number]);
    this.broadcast({ t: "reveal", hostSecret: this.hostSecret, nonce: this.nonce, deck });
  }

  /** Who decides for the active seat right now: a bot level, or null for a present human. */
  activeBotLevel(): BotLevel | null {
    const s = this.state;
    if (!s || s.phase !== TurnPhase.PLACE_TILE) return null;
    const seat = this.seats[s.player];
    if (seat.kind === "bot") return seat.level ?? "normal";
    if (!seat.local && !seat.connected && this.settings.replaceAbsent) return "normal";
    return null;
  }

  private maybeRunBot(): void {
    const level = this.activeBotLevel();
    if (!level) return;
    const state = this.state!;
    const epoch = this.botEpoch, player = state.player;
    const view = publicView(state); // the bot never sees the hidden order
    this.opts.botRunner(view, { level, seedKey: botSeedKey(state) })
      .catch(() => fallbackTurn(view))
      .then((turn) => {
        if (epoch !== this.botEpoch || !this.state || this.state.player !== player) return; // stale
        let actions = turnActions(turn);
        if (applyAction(this.state, actions[0], player).ok === false) actions = turnActions(fallbackTurn(view));
        for (const a of actions) {
          const cur = this.state;
          if (!cur || cur.phase === TurnPhase.GAME_OVER || cur.player !== player) break;
          if (a.type !== "PLACE_TILE" && cur.phase !== TurnPhase.PLACE_MEEPLE) break;
          const err = this.apply(player, a);
          if (err && a.type === "PLACE_MEEPLE") this.apply(player, { type: "SKIP_MEEPLE" });
        }
      });
  }

  // ------------------------------------------------------------------ network
  private sendTo(conn: number, msg: HostMessage): void { this.transport.send(conn, JSON.stringify(msg)); }
  private broadcast(msg: HostMessage): void {
    const text = JSON.stringify(msg);
    for (const [conn, c] of this.conns) if (c.seat) this.transport.send(conn, text);
  }

  onConnect(conn: number): void {
    this.conns.set(conn, { seat: null, count: 0, windowStart: 0 });
  }

  onDisconnect(conn: number): void {
    const c = this.conns.get(conn);
    this.conns.delete(conn);
    if (!c?.seat) return;
    const seat = c.seat;
    seat.conn = null;
    seat.connected = false;
    if (!this.state) { this.seats = this.seats.filter((s) => s !== seat); this.lobbyChanged(); return; }
    this.broadcast({ t: "presence", playerId: seat.id, connected: false, bot: this.settings.replaceAbsent });
    this.botEpoch++;
    this.maybeRunBot();
    this.opts.onChange?.();
  }

  onMessage(conn: number, text: string, now = Date.now()): void {
    const c = this.conns.get(conn);
    if (!c) return;
    if (now - c.windowStart > 1000) { c.windowStart = now; c.count = 0; }
    if (++c.count > RATE_PER_SECOND || typeof text !== "string" || text.length > MAX_MESSAGE_BYTES) { this.rejected++; return; }
    const msg = parseClientMessage(text);
    if (!msg) { this.rejected++; this.sendTo(conn, { t: "error", reason: "Message invalide." }); return; }
    if (msg.t === "hello") return this.onHello(conn, c, msg);
    const seat = c.seat;
    if (!seat) { this.rejected++; this.sendTo(conn, { t: "error", reason: "Identifiez-vous d'abord." }); return; }
    switch (msg.t) {
      case "ready":
        if (this.state) return;
        seat.ready = msg.ready;
        seat.entropy = msg.entropy;
        this.lobbyChanged();
        return;
      case "color":
        if (!this.state && !this.seats.some((s) => s !== seat && s.color === msg.color)) { seat.color = msg.color; this.lobbyChanged(); }
        return;
      case "resync":
        this.sendSnapshot(conn);
        return;
      case "bye":
        this.transport.close(conn);
        this.onDisconnect(conn);
        return;
      case "action": {
        const rev = this.state?.rev ?? 0;
        const reject = (reason: string) => { this.rejected++; this.sendTo(conn, { t: "reject", seq: msg.seq, reason, rev }); };
        if (msg.sessionId !== this.sessionId) return reject("Session inconnue.");
        if (msg.playerId !== seat.id) return reject("Vous ne pouvez jouer que pour votre propre siège.");
        if (msg.seq <= seat.lastSeq) return; // duplicate delivery: already handled, ignore silently
        if (msg.seq !== seat.lastSeq + 1) return reject("Message hors séquence.");
        if (!this.state) return reject("La partie n'a pas commencé.");
        if (msg.rev !== this.state.rev) { seat.lastSeq = msg.seq; return reject("État périmé."); }
        seat.lastSeq = msg.seq;
        const err = this.apply(this.seats.indexOf(seat), msg.action);
        if (err) reject(err);
        return;
      }
    }
  }

  private onHello(conn: number, c: { seat: Seat | null }, msg: { v: number; name: string; sessionId?: string; token?: string }): void {
    if (msg.v !== PROTOCOL_VERSION) { this.sendTo(conn, { t: "error", reason: `Version de protocole ${msg.v} incompatible (attendu ${PROTOCOL_VERSION}).` }); this.transport.close(conn); return; }
    if (c.seat) return;
    let seat: Seat | null = null;
    if (msg.token && msg.sessionId === this.sessionId) {
      // Reconnection: the secret token proves the identity of a known seat.
      seat = this.seats.find((s) => !s.local && s.token === msg.token) ?? null;
      if (seat && seat.conn !== null) { this.transport.close(seat.conn); this.conns.delete(seat.conn); }
    }
    if (!seat) {
      if (this.state) { this.sendTo(conn, { t: "error", reason: "La partie a déjà commencé." }); this.transport.close(conn); return; }
      seat = this.newSeat(msg.name, "human", false);
      if (!seat) { this.sendTo(conn, { t: "error", reason: "La partie est complète." }); this.transport.close(conn); return; }
      seat.ready = false;
    }
    seat.conn = conn;
    seat.connected = true;
    c.seat = seat;
    this.sendTo(conn, { t: "welcome", v: PROTOCOL_VERSION, sessionId: this.sessionId, playerId: seat.id, token: seat.token, hostCommit: this.hostCommit });
    if (this.state) {
      this.sendSnapshot(conn);
      this.broadcast({ t: "presence", playerId: seat.id, connected: true, bot: false });
      this.botEpoch++; // cancel a replacement bot that was thinking for this seat
      this.maybeRunBot();
      this.opts.onChange?.();
    } else this.lobbyChanged();
  }

  /** Authorised snapshot: public data only (revealed tiles + validated actions). */
  private sendSnapshot(conn: number): void {
    const s = this.state;
    if (!s || !this.record) { this.sendTo(conn, { t: "lobby", seats: this.seatInfos(), settings: this.settings }); return; }
    this.sendTo(conn, { t: "lobby", seats: this.seatInfos(), settings: this.settings });
    this.sendTo(conn, {
      t: "snapshot", config: s.config, tiles: s.deck.tiles.slice(0, s.deck.pos), total: s.deck.total,
      actions: this.record.actions, deckCommit: this.deckCommit, entropies: this.entropies, hash: stateHash(s),
    });
    if (this.revealed) {
      const deck = (s.deck.total < 0 ? s.deck.tiles : this.fullDeck).map((t) => [t.topologyId, t.seed] as [string, number]);
      this.sendTo(conn, { t: "reveal", hostSecret: this.hostSecret, nonce: this.nonce, deck });
    }
  }

  /** Close every connection (host leaves). */
  shutdown(): void {
    for (const conn of this.conns.keys()) { this.sendTo(conn, { t: "error", reason: "L'hôte a fermé la partie." }); this.transport.close(conn); }
    this.conns.clear();
    this.botEpoch++;
  }
}
