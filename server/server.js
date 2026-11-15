#!/usr/bin/env node
/**
 * Stand-alone relay: `node server.js` (PORT, default 8787).
 * Uses Redis when UPSTASH_REDIS_REST_URL / _TOKEN (or KV_REST_API_URL / _TOKEN) are set,
 * otherwise keeps everything in memory, which is enough for a single process.
 */
import { createServer } from "node:http";
import { createRelay } from "./src/relay.js";
import { nodeHandler } from "./src/node.js";
import { storeFromEnv } from "./src/stores.js";

const port = Number(process.env.PORT) || 8787;
const store = storeFromEnv();
const server = createServer(nodeHandler(createRelay(store)));
server.requestTimeout = 60000;
server.listen(port, () => console.log(`Bastides relay on http://localhost:${port} (store: ${store.kind})`));
