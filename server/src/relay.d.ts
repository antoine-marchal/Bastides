import type { Store } from "./stores.js";
export declare const LIMITS: { roomTtlSeconds: number; maxGuests: number; maxFrameBytes: number; maxFramesPerSend: number; maxMailbox: number; guestTimeoutMs: number; hostTimeoutMs: number };
export declare const ROOM_CODE: RegExp;
export declare const CORS_HEADERS: Record<string, string>;
export declare const MAX_BODY_BYTES: number;
export interface RelayRequest { method: string; path: string; query: Record<string, string>; body: unknown; signal?: AbortSignal }
export interface Relay { handle(req: RelayRequest): Promise<{ status: number; body: any }> }
export declare function createRelay(store: Store, opts?: { now?: () => number; pollWaitMs?: number }): Relay;
