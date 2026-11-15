/** Vercel entry point: every route is rewritten here (see vercel.json). */
import { createRelay } from "../src/relay.js";
import { nodeHandler } from "../src/node.js";
import { storeFromEnv } from "../src/stores.js";

// Module scope: reused while the instance stays warm.
const handler = nodeHandler(createRelay(storeFromEnv()));
export default handler;
