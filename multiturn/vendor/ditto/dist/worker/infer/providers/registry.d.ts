import type { ModelProvider, ProviderResolver } from "./types.js";
export declare class ProviderRegistry implements ProviderResolver {
    #private;
    constructor(providers?: Readonly<Record<string, ModelProvider>>);
    register(name: string, provider: ModelProvider): () => boolean;
    get(name?: string): ModelProvider;
}
//# sourceMappingURL=registry.d.ts.map