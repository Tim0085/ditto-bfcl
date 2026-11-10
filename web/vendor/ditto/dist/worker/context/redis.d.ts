import type { ContextStateStore } from "./types.js";
/** Compatible with node-redis; adapt other SDKs with two small forwarding functions. */
export interface RedisContextClient {
    get(key: string): Promise<string | null>;
    eval(script: string, options: {
        keys: string[];
        arguments: string[];
    }): Promise<unknown>;
}
export interface RedisContextOptions {
    readonly keyPrefix?: string;
    readonly ttlMs?: number;
}
/** One key per scope, atomic version check/write/expiry, no SDK or connection ownership. */
export declare function createRedisContextStore(client: RedisContextClient, options?: RedisContextOptions): ContextStateStore;
//# sourceMappingURL=redis.d.ts.map