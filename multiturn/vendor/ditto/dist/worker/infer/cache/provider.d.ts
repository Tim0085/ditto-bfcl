import type { CacheLookupInput, CacheLookupOutput, CacheWriteInput, CacheWriteOutput, CacheInvalidateInput, CacheInvalidateOutput } from "./index.js";
export interface InferCacheCallOptions {
    readonly signal?: AbortSignal;
}
export interface InferCacheProvider {
    lookup(input: CacheLookupInput, options?: InferCacheCallOptions): Promise<CacheLookupOutput>;
    write(input: CacheWriteInput, options?: InferCacheCallOptions): Promise<CacheWriteOutput>;
    invalidate(input: CacheInvalidateInput, options?: InferCacheCallOptions): Promise<CacheInvalidateOutput>;
}
/** Bounded, LRU, isolated snapshots; no background timer. Use a shared backend for replicas. */
export declare class InMemoryInferCache implements InferCacheProvider {
    #private;
    constructor(options?: {
        maxEntries?: number;
        now?: () => number;
    });
    lookup(input: CacheLookupInput): Promise<CacheLookupOutput>;
    write(input: CacheWriteInput): Promise<CacheWriteOutput>;
    invalidate({ selector }: CacheInvalidateInput): Promise<CacheInvalidateOutput>;
}
//# sourceMappingURL=provider.d.ts.map