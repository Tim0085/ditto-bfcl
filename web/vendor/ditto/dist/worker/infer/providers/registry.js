import { InferError } from "../validation.js";
export class ProviderRegistry {
    #providers = new Map();
    constructor(providers = {}) {
        for (const [name, provider] of Object.entries(providers))
            this.register(name, provider);
    }
    register(name, provider) {
        if (!name.trim() || this.#providers.has(name))
            throw new Error(`Duplicate or empty provider: ${name}`);
        this.#providers.set(name, provider);
        return () => this.#providers.get(name) === provider && this.#providers.delete(name);
    }
    get(name) {
        const selected = name ?? (this.#providers.size === 1 ? this.#providers.keys().next().value : undefined);
        const provider = selected === undefined ? undefined : this.#providers.get(selected);
        if (!provider)
            throw new InferError("PROVIDER_NOT_FOUND", `Provider is not configured or ambiguous: ${selected ?? "(default)"}`);
        return provider;
    }
}
//# sourceMappingURL=registry.js.map