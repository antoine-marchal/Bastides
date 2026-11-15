/**
 * Storage back-ends for the relay.
 *
 * - memoryStore: one process (local run, a VPS, Render, Fly...). Long-polls wake instantly.
 * - upstashStore: Redis over HTTPS (Upstash, or Vercel's Redis integration). Needed on
 *   serverless platforms, where successive requests may hit different instances.
 *
 * @typedef {object} Store
 * @property {string} kind
 * @property {number} [pollWaitMs]  longest long-poll this back-end should hold
 * @property {(key: string) => Promise<Record<string,string>|null>} hgetall
 * @property {(key: string, field: string) => Promise<string|null>} hget
 * @property {(key: string, fields: Record<string,string>, ttl: number) => Promise<void>} hset
 * @property {(key: string, field: string, value: string, ttl: number) => Promise<boolean>} hsetnx
 * @property {(key: string, ttl: number) => Promise<number>} incr
 * @property {(key: string, values: string[], ttl: number) => Promise<number>} push  returns the new length
 * @property {(key: string, after: number) => Promise<string[]>} range  items from index `after`
 * @property {(key: string, after: number, waitMs: number, signal?: AbortSignal) => Promise<string[]>} waitRange
 */

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/** @returns {Store} */
export function memoryStore() {
  /** @type {Map<string, { v: any, exp: number }>} */
  const data = new Map();
  /** @type {Map<string, Set<() => void>>} */
  const waiters = new Map();
  const live = (key) => {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) { data.delete(key); return undefined; }
    return e;
  };
  const touch = (key, init, ttl) => {
    let e = live(key);
    if (!e) { e = { v: init(), exp: 0 }; data.set(key, e); }
    e.exp = Date.now() + ttl * 1000;
    return e;
  };
  const wake = (key) => { for (const w of waiters.get(key) ?? []) w(); waiters.delete(key); };
  // Periodic sweep of expired keys.
  const sweep = setInterval(() => { for (const k of [...data.keys()]) live(k); }, 60000);
  sweep.unref?.();

  return {
    kind: "memory",
    pollWaitMs: 25000,
    async hgetall(key) { const e = live(key); return e ? { ...e.v } : null; },
    async hget(key, field) { return live(key)?.v[field] ?? null; },
    async hset(key, fields, ttl) { Object.assign(touch(key, () => ({}), ttl).v, fields); },
    async hsetnx(key, field, value, ttl) {
      const e = touch(key, () => ({}), ttl);
      if (field in e.v) return false;
      e.v[field] = value;
      return true;
    },
    async incr(key, ttl) { const e = touch(key, () => 0, ttl); return ++e.v; },
    async push(key, values, ttl) { const e = touch(key, () => [], ttl); e.v.push(...values); wake(key); return e.v.length; },
    async range(key, after) { return (live(key)?.v ?? []).slice(after); },
    async waitRange(key, after, waitMs, signal) {
      const now = (live(key)?.v ?? []).slice(after);
      if (now.length || waitMs <= 0 || signal?.aborted) return now;
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); waiters.get(key)?.delete(done); resolve(); };
        const t = setTimeout(done, waitMs);
        if (!waiters.has(key)) waiters.set(key, new Set());
        waiters.get(key).add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      return (live(key)?.v ?? []).slice(after);
    },
  };
}

/**
 * Redis through the Upstash REST API (no client library needed).
 * @param {string} url  e.g. https://xxx.upstash.io
 * @param {string} token
 * @returns {Store}
 */
export function upstashStore(url, token) {
  const base = url.replace(/\/+$/, "");
  async function pipeline(cmds) {
    const res = await fetch(base + "/pipeline", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
    const out = await res.json();
    for (const r of out) if (r.error) throw new Error("Redis: " + r.error);
    return out.map((r) => r.result);
  }
  const ex = (key, ttl) => ["EXPIRE", key, String(ttl)];
  const toObj = (flat) => {
    if (!flat || !flat.length) return null;
    const o = {};
    for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
    return o;
  };
  const range = async (key, after) => (await pipeline([["LRANGE", key, String(after), "-1"]]))[0] ?? [];

  return {
    kind: "upstash-redis",
    // Stay well under the function time limit; every step costs one Redis command.
    pollWaitMs: 8000,
    async hgetall(key) { return toObj((await pipeline([["HGETALL", key]]))[0]); },
    async hget(key, field) { return (await pipeline([["HGET", key, field]]))[0] ?? null; },
    async hset(key, fields, ttl) { await pipeline([["HSET", key, ...Object.entries(fields).flat()], ex(key, ttl)]); },
    async hsetnx(key, field, value, ttl) { const [r] = await pipeline([["HSETNX", key, field, value], ex(key, ttl)]); return r === 1; },
    async incr(key, ttl) { const [n] = await pipeline([["INCR", key], ex(key, ttl)]); return n; },
    async push(key, values, ttl) { const [n] = await pipeline([["RPUSH", key, ...values], ex(key, ttl)]); return n; },
    range,
    async waitRange(key, after, waitMs, signal) {
      const until = Date.now() + waitMs;
      for (;;) {
        const items = await range(key, after);
        if (items.length || Date.now() + 900 > until || signal?.aborted) return items;
        await sleep(900, signal);
      }
    },
  };
}

/** Pick the store from the environment: Upstash/Vercel Redis variables, else memory. */
export function storeFromEnv(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  return url && token ? upstashStore(url, token) : memoryStore();
}
