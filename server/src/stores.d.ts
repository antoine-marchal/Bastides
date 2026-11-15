export interface Store {
  kind: string;
  pollWaitMs?: number;
  hgetall(key: string): Promise<Record<string, string> | null>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, fields: Record<string, string>, ttl: number): Promise<void>;
  hsetnx(key: string, field: string, value: string, ttl: number): Promise<boolean>;
  incr(key: string, ttl: number): Promise<number>;
  push(key: string, values: string[], ttl: number): Promise<number>;
  range(key: string, after: number): Promise<string[]>;
  waitRange(key: string, after: number, waitMs: number, signal?: AbortSignal): Promise<string[]>;
}
export declare function memoryStore(): Store;
export declare function upstashStore(url: string, token: string): Store;
export declare function storeFromEnv(env?: Record<string, string | undefined>): Store;
