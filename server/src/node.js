/** Adapter between Node's http (IncomingMessage / ServerResponse) and the relay handler. */
import { CORS_HEADERS, MAX_BODY_BYTES } from "./relay.js";

async function readBody(req) {
  if (req.body !== undefined) return req.body; // already parsed (Vercel)
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

function send(res, status, body) {
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** @param {{ handle: Function }} relay */
export function nodeHandler(relay) {
  return async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); res.end(); return; }
    const url = new URL(req.url ?? "/", "http://relay");
    let body;
    try { body = await readBody(req); } catch (e) { send(res, e.status ?? 400, { error: "Requête trop volumineuse." }); return; }
    if (body === null) { send(res, 400, { error: "JSON invalide." }); return; }
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    // Vercel rewrites every path to /api: the original path travels in ?path=.
    const path = url.searchParams.get("path") ?? url.pathname;
    const out = await relay.handle({ method: req.method ?? "GET", path, query: Object.fromEntries(url.searchParams), body, signal: ac.signal });
    if (!res.writableEnded) send(res, out.status, out.body);
  };
}
