/**
 * Bastides relay: a tiny mailbox server for online games.
 *
 * The server never runs the game. The host player's app stays authoritative (it holds the
 * secret deck and validates every action); the relay only carries opaque text frames between
 * the host and its guests, through HTTP long-polling so that it runs on serverless platforms
 * (Vercel, Netlify...) that cannot keep WebSockets open.
 *
 *   POST /rooms                       -> { room, key }               create a room (caller = host)
 *   POST /rooms/:room/join            -> { conn, key }               join as a guest
 *   POST /rooms/:room/send            { key, frames }                host: frames=[{to, text, close?}], guest: frames=[text]
 *   GET  /rooms/:room/poll?key&after  -> { events, next, closed? }   read one's mailbox (long-poll)
 *   POST /rooms/:room/leave           { key }                        guest leaves / host closes the room
 *   GET  /health                      -> { ok, store }
 *
 * Host mailbox events: { k: "open"|"message"|"close", conn, text? }. Guest events:
 * { k: "message", text } and { k: "close", reason }. Keys are random 128-bit secrets; the
 * room code itself only grants the right to join, as a lobby code should.
 *
 * Every mutable field lives in its own hash field (no read-modify-write of a shared blob),
 * so concurrent requests on different serverless instances cannot overwrite each other.
 */

export const LIMITS = {
  roomTtlSeconds: 6 * 3600,
  maxGuests: 16,
  maxFrameBytes: 256 * 1024,
  maxFramesPerSend: 64,
  maxMailbox: 20000,
  /** A guest that has not polled for this long is reported to the host as disconnected. */
  guestTimeoutMs: 30000,
  /** Without a host poll for this long, the room is considered abandoned. */
  hostTimeoutMs: 60000,
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
export const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
function randomCode(len = 6) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param {import("./stores.js").Store} store
 * @param {{ now?: () => number, pollWaitMs?: number }} [opts]
 */
export function createRelay(store, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const pollWaitMs = opts.pollWaitMs ?? store.pollWaitMs ?? 20000;
  const TTL = LIMITS.roomTtlSeconds;

  // Keys of one room.
  const K = (room) => ({
    meta: `r:${room}:meta`,     // hostKey, hostSeen, closed
    keys: `r:${room}:keys`,     // conn -> guest key
    seen: `r:${room}:seen`,     // conn -> last poll time
    gone: `r:${room}:gone`,     // conn -> "1" once disconnected
    seq: `r:${room}:seq`,       // last guest connection number
    box: (b) => `r:${room}:box:${b}`, // mailboxes: "h" (host) or "g<conn>"
  });

  async function loadRoom(room) {
    if (!ROOM_CODE.test(room)) throw new HttpError(404, "Salon introuvable.");
    const k = K(room);
    const meta = await store.hgetall(k.meta);
    if (!meta || !meta.hostKey) throw new HttpError(404, "Salon introuvable ou expiré.");
    return { room, k, meta };
  }
  const hostAlive = (meta) => meta.closed !== "1" && now() - Number(meta.hostSeen) <= LIMITS.hostTimeoutMs;

  async function push(k, box, events) {
    if (!events.length) return;
    const len = await store.push(k.box(box), events.map((e) => JSON.stringify(e)), TTL);
    if (len > LIMITS.maxMailbox) throw new HttpError(413, "Trop de messages dans ce salon.");
  }

  /** Identify the caller by its secret key. */
  async function identify(r, key) {
    if (typeof key !== "string" || key.length !== 32) throw new HttpError(403, "Clé invalide.");
    if (key === r.meta.hostKey) return { host: true, conn: 0 };
    const keys = await store.hgetall(r.k.keys);
    for (const [conn, kk] of Object.entries(keys ?? {})) if (kk === key) return { host: false, conn: Number(conn) };
    throw new HttpError(403, "Clé inconnue pour ce salon.");
  }

  /** Mark a guest gone exactly once (hsetnx) and tell the host. */
  async function markGone(r, conn) {
    if (await store.hsetnx(r.k.gone, String(conn), "1", TTL)) await push(r.k, "h", [{ k: "close", conn }]);
  }

  /** Report silent guests to the host (run on host polls). */
  async function reapGuests(r) {
    const [seen, gone] = await Promise.all([store.hgetall(r.k.seen), store.hgetall(r.k.gone)]);
    const t = now();
    for (const [conn, at] of Object.entries(seen ?? {})) {
      if (!gone?.[conn] && t - Number(at) > LIMITS.guestTimeoutMs) await markGone(r, Number(conn));
    }
  }

  const routes = {
    async create() {
      for (let attempt = 0; attempt < 8; attempt++) {
        const room = randomCode();
        const k = K(room), hostKey = randomHex();
        if (await store.hsetnx(k.meta, "hostKey", hostKey, TTL)) {
          await store.hset(k.meta, { hostSeen: String(now()), closed: "0", created: String(now()) }, TTL);
          return { room, key: hostKey };
        }
      }
      throw new HttpError(503, "Impossible de créer un salon, réessayez.");
    },

    async join(room) {
      const r = await loadRoom(room);
      if (!hostAlive(r.meta)) throw new HttpError(410, "L'hôte n'est plus présent dans ce salon.");
      const conn = await store.incr(r.k.seq, TTL);
      if (conn > LIMITS.maxGuests * 4) throw new HttpError(429, "Trop de connexions pour ce salon.");
      const key = randomHex();
      await store.hset(r.k.keys, { [conn]: key }, TTL);
      await store.hset(r.k.seen, { [conn]: String(now()) }, TTL);
      await push(r.k, "h", [{ k: "open", conn }]);
      return { conn, key };
    },

    async send(room, body) {
      const r = await loadRoom(room);
      const who = await identify(r, body.key);
      const frames = body.frames;
      if (!Array.isArray(frames) || frames.length > LIMITS.maxFramesPerSend) throw new HttpError(400, "Trames invalides.");
      if (r.meta.closed === "1") throw new HttpError(410, "Le salon est fermé.");
      if (who.host) {
        const gone = (await store.hgetall(r.k.gone)) ?? {};
        const byConn = new Map();
        for (const f of frames) {
          if (!f || !Number.isInteger(f.to) || typeof f.text !== "string" || f.text.length > LIMITS.maxFrameBytes) throw new HttpError(400, "Trame invalide.");
          if (gone[f.to]) continue; // the guest left: drop silently
          if (!byConn.has(f.to)) byConn.set(f.to, []);
          byConn.get(f.to).push(f.close ? { k: "close", reason: f.text } : { k: "message", text: f.text });
        }
        for (const [conn, evs] of byConn) {
          await push(r.k, "g" + conn, evs);
          if (evs.some((e) => e.k === "close")) await store.hsetnx(r.k.gone, String(conn), "1", TTL);
        }
      } else {
        if (await store.hget(r.k.gone, String(who.conn))) throw new HttpError(410, "Vous n'êtes plus dans ce salon.");
        const evs = [];
        for (const f of frames) {
          if (typeof f !== "string" || f.length > LIMITS.maxFrameBytes) throw new HttpError(400, "Trame invalide.");
          evs.push({ k: "message", conn: who.conn, text: f });
        }
        await push(r.k, "h", evs);
      }
      return { ok: true };
    },

    async poll(room, query, signal) {
      const r = await loadRoom(room);
      const who = await identify(r, query.key);
      const after = Math.max(0, Number.parseInt(query.after ?? "0", 10) || 0);
      if (who.host) {
        await store.hset(r.k.meta, { hostSeen: String(now()) }, TTL);
        await reapGuests(r);
      } else {
        if (await store.hget(r.k.gone, String(who.conn))) {
          // Deliver what is still queued (a final error from the host...), then close.
          const rest = await store.range(r.k.box("g" + who.conn), after);
          return { events: [...rest.map((t) => JSON.parse(t)), { k: "close", reason: "Vous n'êtes plus dans ce salon." }], next: after + rest.length, closed: true };
        }
        await store.hset(r.k.seen, { [who.conn]: String(now()) }, TTL);
        if (!hostAlive(r.meta)) {
          const rest = await store.range(r.k.box("g" + who.conn), after);
          return { events: [...rest.map((t) => JSON.parse(t)), { k: "close", reason: "L'hôte a quitté le salon." }], next: after + rest.length, closed: true };
        }
      }
      const wait = Math.min(pollWaitMs, Math.max(0, Number.parseInt(query.wait ?? String(pollWaitMs), 10) || 0));
      const raw = await store.waitRange(r.k.box(who.host ? "h" : "g" + who.conn), after, wait, signal);
      return { events: raw.map((t) => JSON.parse(t)), next: after + raw.length };
    },

    async leave(room, body) {
      const r = await loadRoom(room);
      const who = await identify(r, body.key);
      if (who.host) {
        await store.hset(r.k.meta, { closed: "1" }, TTL);
        const [keys, gone] = await Promise.all([store.hgetall(r.k.keys), store.hgetall(r.k.gone)]);
        for (const conn of Object.keys(keys ?? {})) if (!gone?.[conn]) await push(r.k, "g" + conn, [{ k: "close", reason: "L'hôte a fermé le salon." }]);
      } else await markGone(r, who.conn);
      return { ok: true };
    },
  };

  /**
   * Framework-free request handler.
   * @param {{ method: string, path: string, query: Record<string,string>, body: any, signal?: AbortSignal }} req
   * @returns {Promise<{ status: number, body: any }>}
   */
  async function handle(req) {
    try {
      const parts = req.path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      if (parts[0] === "api") parts.shift();
      if (req.method === "GET" && (parts.length === 0 || parts[0] === "health")) return { status: 200, body: { ok: true, service: "bastides-relay", version: 1, store: store.kind } };
      if (parts[0] !== "rooms") throw new HttpError(404, "Route inconnue.");
      if (parts.length === 1 && req.method === "POST") return { status: 200, body: await routes.create() };
      const room = (parts[1] ?? "").toUpperCase();
      const op = parts[2];
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (req.method === "POST" && op === "join") return { status: 200, body: await routes.join(room) };
      if (req.method === "POST" && op === "send") return { status: 200, body: await routes.send(room, body) };
      if (req.method === "POST" && op === "leave") return { status: 200, body: await routes.leave(room, body) };
      if (req.method === "GET" && op === "poll") return { status: 200, body: await routes.poll(room, req.query ?? {}, req.signal) };
      throw new HttpError(404, "Route inconnue.");
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      console.error(e);
      return { status: 500, body: { error: "Erreur interne du relais." } };
    }
  }

  return { handle };
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
};

/** Max accepted request body (a host batch of frames). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
