import { describe, expect, it } from "vitest";
import { createRandom } from "../src/core/random";
import { chooseTurn, turnActions } from "../src/ai/bots";
import { legalPlacements, stateHash } from "../src/game/gameEngine";
import { TurnPhase } from "../src/game/state";
import type { GameAction } from "../src/game/state";
import { GameHost } from "../src/multiplayer/authority";
import { ClientSession } from "../src/multiplayer/session";
import { MAX_MESSAGE_BYTES, decodeRoomCode, encodeRoomCode, parseAction, parseClientMessage } from "../src/multiplayer/protocol";
import type { HostMessage } from "../src/multiplayer/protocol";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** In-memory network with optional per-client frame mangling. */
class Net {
  host: GameHost;
  clients = new Map<number, ClientSession>();
  sent: { conn: number; text: string }[] = [];
  mangle = new Map<number, (text: string, deliver: (t: string) => void) => void>();
  private rng = createRandom("net");
  private nextConn = 1;

  constructor(settings = {}) {
    this.host = new GameHost({
      random: () => Array.from({ length: 4 }, () => this.rng.nextUint32().toString(16).padStart(8, "0")).join(""),
      botRunner: async (view, opts) => chooseTurn(view, { ...opts, simulations: 12 }),
      transport: {
        send: (conn, text) => {
          this.sent.push({ conn, text });
          const c = this.clients.get(conn);
          if (!c) return;
          const m = this.mangle.get(conn);
          if (m) m(text, (t) => c.onMessage(t)); else c.onMessage(text);
        },
        close: (conn) => { this.clients.delete(conn); },
      },
      settings,
    });
  }
  join(name: string, resume?: ClientSession): { client: ClientSession; conn: number } {
    const conn = this.nextConn++;
    const client = new ClientSession({
      name, entropy: createRandom("entropy:" + name).nextUint32().toString(16).padStart(8, "0"),
      send: (text) => this.host.onMessage(conn, text),
      resume: resume ? { sessionId: resume.sessionId, token: resume.token, playerId: resume.playerId } : undefined,
    });
    this.clients.set(conn, client);
    this.host.onConnect(conn);
    client.onOpen();
    return { client, conn };
  }
  drop(conn: number): void { this.clients.delete(conn); this.host.onDisconnect(conn); }
}

/** Let remote humans (played here by a simple policy on their own replica) and host bots finish the game. */
async function playOut(net: Net, humans: ClientSession[], maxTicks = 4000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const hs = net.host.state!;
    if (hs.phase === TurnPhase.GAME_OVER) return;
    for (const c of humans) {
      const s = c.state;
      if (!s || s.phase === TurnPhase.GAME_OVER || s.player !== c.myIndex() || s.rev !== hs.rev) continue;
      if (s.phase === TurnPhase.PLACE_TILE) c.submit({ type: "PLACE_TILE", ...legalPlacements(s)[0] });
      else if (s.phase === TurnPhase.PLACE_MEEPLE) c.submit({ type: "SKIP_MEEPLE" });
    }
    await tick();
  }
  throw new Error("network game did not finish");
}

function setup(settings = {}) {
  const net = new Net({ mode: "procedural", deckSize: 26, ...settings });
  const a = net.join("Alice"), b = net.join("Bob");
  a.client.setReady(true); b.client.setReady(true);
  return { net, a, b };
}

describe("multiplayer", () => {
  it("lobby: join, seats, colours, readiness, bots, refusal when full or started", () => {
    const { net, a, b } = setup();
    expect(net.host.seats.map((s) => s.name)).toEqual(["Alice", "Bob"]);
    expect(a.client.playerId).not.toBe(b.client.playerId);
    expect(a.client.seats.length).toBe(2);
    expect(a.client.hostCommit).toMatch(/^[0-9a-f]{64}$/);
    b.client.setColor(a.client.seats[0].color); // taken: refused
    expect(net.host.seats[1].color).not.toBe(net.host.seats[0].color);
    b.client.setColor(5);
    expect(a.client.seats[1].color).toBe(5);
    net.host.addBot("normal");
    net.host.addLocalPlayer("Hôte");
    net.host.addBot("easy");
    expect(net.host.seats.length).toBe(5);
    expect(net.join("Trop").client.error).toContain("complète");
    b.client.setReady(false);
    expect(net.host.start()).toContain("prêts");
    b.client.setReady(true);
    expect(net.host.start()).toBe("");
    expect(net.join("Tard").client.error).toContain("commencé");
    const old = new ClientSession({ name: "x", entropy: "", send: (t) => net.host.onMessage(99, t.replace('"v":1', '"v":7')) });
    net.clients.set(99, old); net.host.onConnect(99); old.onOpen();
    expect(old.error).toContain("incompatible");
  });

  it("a full network game with remote humans and host bots stays synchronised and audits the deck", async () => {
    const { net, a, b } = setup();
    net.host.addBot("normal");
    expect(net.host.start()).toBe("");
    expect(a.client.state!.config.players.length).toBe(3);
    await playOut(net, [a.client, b.client]);
    const h = stateHash(net.host.state!);
    expect(stateHash(a.client.state!)).toBe(h);
    expect(stateHash(b.client.state!)).toBe(h);
    expect(a.client.state!.players.map((p) => p.score)).toEqual(net.host.state!.players.map((p) => p.score));
    expect(a.client.audit).toEqual({ status: "verified" });
    expect(b.client.audit).toEqual({ status: "verified" });
    expect(a.client.resyncs + b.client.resyncs).toBe(0);
    expect(a.client.actions).toEqual(net.host.record!.actions);
  });

  it("no secret, no future tile and no image ever reaches a client before the end", async () => {
    const { net, a, b } = setup();
    expect(net.host.start()).toBe("");
    const secret = net.host.hostSecret;
    const deck = net.host.record!.deck;
    await playOut(net, [a.client, b.client]);
    let revealedCount = 0, seenReveal = false;
    for (const { text } of net.sent) {
      const m = JSON.parse(text) as HostMessage;
      expect(text).not.toMatch(/data:image|;base64,/);
      if (m.t === "reveal") { seenReveal = true; continue; }
      expect(text.includes(secret)).toBe(false);
      if (m.t === "start") revealedCount = Math.max(revealedCount, m.tiles.length);
      if (m.t === "action") {
        // each frame may only reveal the next tiles of the deck, in order
        for (const t of m.reveal) { /* per-connection duplicates are counted once below */ void t; }
      }
    }
    expect(seenReveal).toBe(true);
    // Reconstruct what one client learnt, frame by frame: always a prefix, never beyond the draw position.
    let known = 0;
    for (const { conn, text } of net.sent) {
      if (conn !== a.conn) continue;
      const m = JSON.parse(text) as HostMessage;
      if (m.t === "start") { known = m.tiles.length; expect(m.tiles).toEqual(deck.slice(0, known)); expect(known).toBeLessThanOrEqual(3); }
      if (m.t === "action") { expect(m.reveal).toEqual(deck.slice(known, known + m.reveal.length)); known += m.reveal.length; expect(m.reveal.length).toBeLessThanOrEqual(4); }
    }
    expect(known).toBe(deck.length);
    expect(a.client.state!.deck.secret).toBeUndefined();
    expect(b.client.state!.replica).toBe(true);
  });

  it("the host rejects illegal, spoofed, stale, malformed and oversized messages", () => {
    const { net, a, b } = setup();
    expect(net.host.start()).toBe("");
    const s0 = net.host.state!;
    const h0 = stateHash(s0);
    const first = s0.player === a.client.myIndex() ? a : b, second = first === a ? b : a;
    const raw = (conn: number, m: unknown) => net.host.onMessage(conn, typeof m === "string" ? m : JSON.stringify(m));
    // out of turn
    second.client.submit({ type: "PLACE_TILE", ...legalPlacements(s0)[0] });
    expect(second.client.lastReject).toContain("tour");
    // illegal placement and wrong phase
    first.client.submit({ type: "PLACE_TILE", x: 40, y: 40, rotation: 0 });
    expect(first.client.lastReject).toContain("illégal");
    first.client.submit({ type: "SKIP_MEEPLE" });
    expect(first.client.lastReject).not.toBe("");
    // spoofing another seat, wrong session
    raw(second.conn, { t: "action", sessionId: net.host.sessionId, playerId: first.client.playerId, seq: 50, rev: s0.rev, action: { type: "PLACE_TILE", ...legalPlacements(s0)[0] } });
    expect(second.client.lastReject).toContain("propre siège");
    raw(first.conn, { t: "action", sessionId: "nope", playerId: first.client.playerId, seq: 51, rev: s0.rev, action: { type: "SKIP_MEEPLE" } });
    expect(first.client.lastReject).toContain("Session");
    // stale revision
    raw(first.conn, { t: "action", sessionId: net.host.sessionId, playerId: first.client.playerId, seq: 3, rev: s0.rev + 5, action: { type: "PLACE_TILE", ...legalPlacements(s0)[0] } });
    expect(first.client.lastReject).toContain("périmé");
    // malformed / hostile payloads
    const before = net.host.rejected;
    raw(first.conn, "{oops");
    raw(first.conn, { t: "action", sessionId: net.host.sessionId, playerId: first.client.playerId, seq: 4, rev: s0.rev, action: { type: "SET_SCORE", score: 999 } });
    raw(first.conn, { t: "action", sessionId: net.host.sessionId, playerId: first.client.playerId, seq: 4, rev: s0.rev, action: { type: "PLACE_TILE", x: "0", y: 1, rotation: 0 } });
    raw(first.conn, "x".repeat(MAX_MESSAGE_BYTES + 1));
    raw(first.conn, { t: "draw", index: 7 });
    net.host.onMessage(12345, JSON.stringify({ t: "resync" })); // unknown connection
    expect(net.host.rejected).toBe(before + 5);
    expect(stateHash(net.host.state!)).toBe(h0);
    expect(parseAction({ type: "PLACE_MEEPLE", regionId: 1, score: 5 })).toEqual({ type: "PLACE_MEEPLE", regionId: 1 });
    expect(parseClientMessage(JSON.stringify({ t: "ready", ready: true, entropy: "zz" }))).toBeNull();
  });

  it("duplicated and out-of-sequence client messages are applied at most once", () => {
    const { net, a, b } = setup();
    expect(net.host.start()).toBe("");
    const s0 = net.host.state!;
    const me = s0.player === a.client.myIndex() ? a : b;
    const action: GameAction = { type: "PLACE_TILE", ...legalPlacements(s0)[0] };
    const frame = JSON.stringify({ t: "action", sessionId: net.host.sessionId, playerId: me.client.playerId, seq: 1, rev: s0.rev, action });
    net.host.onMessage(me.conn, frame);
    const rev = net.host.state!.rev;
    expect(rev).toBe(s0.rev + 1);
    net.host.onMessage(me.conn, frame); // duplicate delivery
    net.host.onMessage(me.conn, frame);
    expect(net.host.state!.rev).toBe(rev);
    expect(net.host.state!.tiles.length).toBe(2);
    // gap in the sequence
    net.host.onMessage(me.conn, JSON.stringify({ t: "action", sessionId: net.host.sessionId, playerId: me.client.playerId, seq: 9, rev, action: { type: "SKIP_MEEPLE" } }));
    expect(me.client.lastReject).toContain("séquence");
    expect(net.host.state!.rev).toBe(rev);
  });

  it("clients tolerate reordered and duplicated frames", async () => {
    const { net, a, b } = setup();
    // Bob receives action frames in swapped pairs, each twice.
    let held: string | null = null;
    net.mangle.set(b.conn, (text, deliver) => {
      if (JSON.parse(text).t !== "action") return deliver(text);
      if (held === null) { held = text; return; }
      const first = held; held = null;
      deliver(text); deliver(first); deliver(text); deliver(first);
    });
    net.host.addBot("easy");
    expect(net.host.start()).toBe("");
    const seq = new Map<number, number>();
    const sendAs = (c: { client: ClientSession; conn: number }, action: GameAction) => {
      const n = (seq.get(c.conn) ?? 0) + 1;
      seq.set(c.conn, n);
      net.host.onMessage(c.conn, JSON.stringify({ t: "action", sessionId: net.host.sessionId, playerId: c.client.playerId, seq: n, rev: net.host.state!.rev, action }));
    };
    for (let i = 0; i < 3000 && net.host.state!.phase !== TurnPhase.GAME_OVER; i++) {
      // Seats are driven from the host state here: Bob's replica lags behind by design.
      for (const c of [a, b]) {
        const hs = net.host.state!;
        if (hs.player !== c.client.myIndex()) continue;
        if (hs.phase === TurnPhase.PLACE_TILE) sendAs(c, { type: "PLACE_TILE", ...legalPlacements(hs)[0] });
        if (net.host.state!.phase === TurnPhase.PLACE_MEEPLE && net.host.state!.player === c.client.myIndex()) sendAs(c, { type: "SKIP_MEEPLE" });
      }
      await tick();
    }
    expect(net.host.state!.phase).toBe(TurnPhase.GAME_OVER);
    if (held !== null) b.client.onMessage(held);
    expect(stateHash(a.client.state!)).toBe(stateHash(net.host.state!));
    expect(stateHash(b.client.state!)).toBe(stateHash(net.host.state!));
    expect(b.client.resyncs).toBe(0);
  });

  it("a diverged replica is detected by hash and repaired with a snapshot", async () => {
    const { net, a, b } = setup();
    expect(net.host.start()).toBe("");
    a.client.state!.players[0].score = 999; // corrupt Alice's replica
    const s = net.host.state!;
    const me = s.player === a.client.myIndex() ? a : b;
    me.client.state = me === a ? a.client.state : b.client.state;
    net.host.onMessage(me.conn, JSON.stringify({ t: "action", sessionId: net.host.sessionId, playerId: me.client.playerId, seq: 1, rev: s.rev, action: { type: "PLACE_TILE", ...legalPlacements(s)[0] } }));
    expect(a.client.resyncs).toBe(1);
    expect(stateHash(a.client.state!)).toBe(stateHash(net.host.state!));
    expect(b.client.resyncs).toBe(0);
  });

  it("disconnection: a bot covers the absent player; reconnection restores the seat from a snapshot", async () => {
    const { net, a, b } = setup({ replaceAbsent: true });
    expect(net.host.start()).toBe("");
    net.drop(b.conn);
    expect(net.host.seats.find((s) => s.id === b.client.playerId)!.connected).toBe(false);
    expect(a.client.seats.find((s) => s.id === b.client.playerId)!.connected).toBe(false);
    // Alice keeps playing; Bob's turns are played by the replacement bot.
    for (let i = 0; i < 400 && net.host.state!.turn < 8; i++) {
      const s = a.client.state!;
      if (s.player === a.client.myIndex() && s.rev === net.host.state!.rev) {
        if (s.phase === TurnPhase.PLACE_TILE) a.client.submit({ type: "PLACE_TILE", ...legalPlacements(s)[0] });
        else if (s.phase === TurnPhase.PLACE_MEEPLE) a.client.submit({ type: "SKIP_MEEPLE" });
      }
      await tick();
    }
    expect(net.host.state!.turn).toBeGreaterThanOrEqual(8);
    const again = net.join("Bob", b.client);
    expect(again.client.playerId).toBe(b.client.playerId);
    expect(net.host.seats.length).toBe(2);
    expect(stateHash(again.client.state!)).toBe(stateHash(net.host.state!));
    expect(net.host.activeBotLevel()).toBeNull();
    // a wrong token cannot hijack the seat
    const thief = new ClientSession({ name: "Eve", entropy: "", send: (t) => net.host.onMessage(77, t), resume: { sessionId: net.host.sessionId, token: "deadbeef", playerId: a.client.playerId } });
    net.clients.set(77, thief); net.host.onConnect(77); thief.onOpen();
    expect(thief.error).toContain("commencé");
    await playOut(net, [a.client, again.client]);
    expect(stateHash(again.client.state!)).toBe(stateHash(net.host.state!));
    expect(again.client.audit.status).toBe("verified");
  });

  it("without replacement the game waits for the absent player", async () => {
    const { net, a, b } = setup({ replaceAbsent: false });
    expect(net.host.start()).toBe("");
    const absent = net.host.state!.player === a.client.myIndex() ? a : b;
    net.drop(absent.conn);
    const rev = net.host.state!.rev;
    for (let i = 0; i < 20; i++) await tick();
    expect(net.host.state!.rev).toBe(rev);
  });

  it("a host that swaps the deck fails the audit", async () => {
    const { net, a, b } = setup();
    expect(net.host.start()).toBe("");
    await playOut(net, [a.client, b.client]);
    const reveal = net.sent.map((x) => JSON.parse(x.text) as HostMessage).find((m) => m.t === "reveal") as Extract<HostMessage, { t: "reveal" }>;
    const forged = { ...reveal, deck: reveal.deck.map((t, i) => (i === reveal.deck.length - 1 ? [t[0], t[1] ^ 1] : t)) };
    a.client.onMessage(JSON.stringify(forged));
    expect(a.client.audit.status).toBe("failed");
    a.client.onMessage(JSON.stringify({ ...reveal, hostSecret: "00" }));
    expect(a.client.audit).toMatchObject({ status: "failed" });
    a.client.onMessage(JSON.stringify(reveal));
    expect(a.client.audit.status).toBe("verified");
  });

  it("local games use the same authority (hot seat + bots), seeded and reproducible", async () => {
    const run = async () => {
      const net = new Net({ mode: "classic" });
      const p1 = net.host.addLocalPlayer("Un")!, p2 = net.host.addLocalPlayer("Deux")!;
      net.host.addBot("normal");
      expect(net.host.start("graine-locale")).toBe("");
      expect(net.host.submitLocal(p2, { type: "SKIP_MEEPLE" })).not.toBe("");
      for (let i = 0; i < 5000 && net.host.state!.phase !== TurnPhase.GAME_OVER; i++) {
        const s = net.host.state!;
        const id = s.config.players[s.player].id;
        if (id === p1 || id === p2) {
          const turn = chooseTurn(s, { level: "normal", seedKey: "hot" + s.turn });
          for (const act of turnActions(turn)) if (net.host.state!.player === s.player && (net.host.state!.phase as TurnPhase) !== TurnPhase.GAME_OVER) net.host.submitLocal(id, act);
        } else await tick();
      }
      return net.host;
    };
    const h1 = await run(), h2 = await run();
    expect(h1.state!.phase).toBe(TurnPhase.GAME_OVER);
    expect(stateHash(h1.state!)).toBe(stateHash(h2.state!));
    expect(h1.record!.actions).toEqual(h2.record!.actions);
  });

  it("room codes encode a LAN address", () => {
    const code = encodeRoomCode("192.168.1.42", 41234);
    expect(code).toMatch(/^[0-9A-Z]+$/);
    expect(decodeRoomCode(code)).toEqual({ ip: "192.168.1.42", port: 41234 });
    expect(decodeRoomCode(code.toLowerCase())).toEqual({ ip: "192.168.1.42", port: 41234 });
    expect(decodeRoomCode("!!")).toBeNull();
    expect(encodeRoomCode("999.1.1.1", 1)).toBe("");
  });
});
