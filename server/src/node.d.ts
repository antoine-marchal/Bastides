import type { Relay } from "./relay.js";
/** (req: IncomingMessage, res: ServerResponse) => Promise<void> */
export declare function nodeHandler(relay: Relay): (req: any, res: any) => Promise<void>;
