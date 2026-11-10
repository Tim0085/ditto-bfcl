import type { RegisteredTool } from "./registry.js";
export interface WebSearchResult {
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
}
export interface WebSearchCallOptions {
    readonly signal?: AbortSignal;
}
export interface WebSearchProvider {
    readonly origin: string;
    search(input: {
        readonly query: string;
        readonly limit: number;
    }, options?: WebSearchCallOptions): Promise<readonly WebSearchResult[]>;
}
export interface WebSearchToolOptions {
    readonly provider: WebSearchProvider;
}
export interface BraveWebSearchProviderOptions {
    readonly apiKey: string;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
    readonly fetch?: typeof globalThis.fetch;
}
/** Optional provider-neutral web search tool. Applications explicitly inject the provider and permissions. */
export declare function createWebSearchTool(options: WebSearchToolOptions): RegisteredTool;
/** Brave Web Search REST adapter; credentials and request lifecycle stay outside Node payloads. */
export declare function createBraveWebSearchProvider(options: BraveWebSearchProviderOptions): WebSearchProvider;
//# sourceMappingURL=web-search.d.ts.map