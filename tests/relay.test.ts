import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelay, LIMITS } from "../server/src/relay.js";
import { nodeHandler } from "../server/src/node.js";
import { memoryStore } from "../server/src/stores.js";
import { chooseTurn } from "../src/ai/bots";
import { createRandom } from "../src/core/random";
import { legalPlacements, stateHash } from "../src/game/gameEngine";
import { TurnPhase } from "../src/game/state";
import { GameHost } from "../src/multiplayer/authority";
import { RelayHost, RelayLink, normalizeServerUrl } from "../src/multiplayer/relayClient";
import { ClientSession } from "../src/multiplayer/session";

let base = "";
// Node's http module, typed loosely: the project does not ship Node type definitions.
const { createServer } = (await import(/* @vite-ignore */ "node:" + "http")) as { createServer: (h: unknown) => any };
const server = createServer(nodeHandler(createRelay(memoryStore(), { pollWaitMs: 2000 })));
beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

const until = async (cond: () => boolean, ms = 20000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); }
};
const json = async (path: string, body?: unknown) => {
  const res = await fetch(base + path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

describe("relay server", () => {
  it("health, CORS-free JSON API, unknown rooms and keys are refused", async () => {
    expect((await json("/health")).body).toMatchObject({ ok: true, service: "bastides-relay", store: "memory" });
    expect((await json("/rooms/ZZZZZZ/join", {})).status).toBe(404);
    const room = (await json("/rooms", {})).body as { room: string; key: string };
    expect(room.room).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect((await json(`/rooms/${room.room}/send`, { key: "0".repeat(32), frames: [] })).status).toBe(403);
    expect((await fetch(`${base}/rooms/${room.room}/poll?key=${"1".repeat(32)}&after=0&wait=0`)).status).toBe(403);
    const opt = await fetch(base + "/rooms", { method: "OPTIONS" });
    expect(opt.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("normalizes server addresses", () => {
    expect(normalizeServerUrl("relay.example.app/")).toBe("https://relay.example.app");
    expect(normalizeServerUrl("localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeServerUrl("  ")).toBe("");
  });

  it("carries a full online game between an authoritative host and two guests", async () => {
    const rng = createRandom("relay");
    let relay: RelayHost | null = null;
    const host = new GameHost({
      random: () => Array.from({ length: 4 }, () => rng.nextUint32().toString(16).padStart(8, "0")).join(""),
      botRunner: async (view, opts) => chooseTurn(view, { ...opts, simulations: 8 }),
      transport: { send: (c, t) => relay!.transport.send(c, t), close: (c) => relay!.transport.close(c) },
      settings: { mode: "procedural", deckSize: 24 },
    });
    relay = await RelayHost.open(base, { open: (c) => host.onConnect(c), message: (c, t) => host.onMessage(c, t), close: (c) => host.onDisconnect(c) });
    host.addLocalPlayer("Hôte");

    const guests = ["Alice", "Bob"].map((name) => {
      const link = new RelayLink(base, relay!.room);
      const client = new ClientSession({ name, entropy: rng.nextUint32().toString(16), send: (t) => link.send(t) });
      link.onopen = () => client.onOpen();
      link.onmessage = (t) => client.onMessage(t);
      return { link, client };
    });
    await until(() => host.seats.length === 3 && guests.every((g) => g.client.playerId));
    for (const g of guests) g.client.setReady(true);
    await until(() => host.canStart() === "");
    expect(host.start()).toBe("");

    // Everyone plays its first legal placement; the host plays its own seat locally.
    await until(() => {
      const s = host.state!;
      if (s.phase === TurnPhase.GAME_OVER) return true;
      if (host.seats[s.player].local) {
        if (s.phase === TurnPhase.PLACE_TILE) host.submitLocal(host.seats[s.player].id, { type: "PLACE_TILE", ...legalPlacements(s)[0] });
        else if (s.phase === TurnPhase.PLACE_MEEPLE) host.submitLocal(host.seats[s.player].id, { type: "SKIP_MEEPLE" });
      }
      for (const g of guests) {
        const c = g.client.state;
        if (!c || c.rev !== s.rev || c.player !== g.client.myIndex()) continue;
        if (c.phase === TurnPhase.PLACE_TILE) g.client.submit({ type: "PLACE_TILE", ...legalPlacements(c)[0] });
        else if (c.phase === TurnPhase.PLACE_MEEPLE) g.client.submit({ type: "SKIP_MEEPLE" });
      }
      return false;
    }, 60000);
    await until(() => guests.every((g) => g.client.audit.status !== "pending"));
    for (const g of guests) {
      expect(stateHash(g.client.state!)).toBe(stateHash(host.state!));
      expect(g.client.audit).toEqual({ status: "verified" });
    }

    // A guest leaving is reported to the host; closing the room closes the other guest.
    guests[0].link.close();
    await until(() => !host.seats[1].connected);
    let reason = "";
    guests[1].link.onclose = (r) => { reason = r ?? ""; };
    await relay.stop();
    await until(() => reason !== "");
    expect(reason).toMatch(/hôte/);
  }, 90000);

  it("limits are sane", () => {
    expect(LIMITS.guestTimeoutMs).toBeGreaterThan(10000);
  });
});
