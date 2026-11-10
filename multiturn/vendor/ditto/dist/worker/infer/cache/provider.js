import { number } from "../validation.js";
const keyOf = (k) => JSON.stringify([k.namespace ?? "", k.scope, k.key]);
/** Bounded, LRU, isolated snapshots; no background timer. Use a shared backend for replicas. */
export class InMemoryInferCache {
    #entries = new Map();
    #maxEntries;
    #now;
    constructor(options = {}) {
        this.#maxEntries = options.maxEntries ?? 1000;
        number(this.#maxEntries, "maxEntries", 1, Number.MAX_SAFE_INTEGER, true);
        this.#now = options.now ?? Date.now;
    }
    #prune() { const now = this.#now(); for (const [key, e] of this.#entries)
        if (e.expiresAt <= now)
            this.#entries.delete(key); }
    async lookup(input) {
        const key = keyOf(input.key);
        const entry = this.#entries.get(key);
        if (!entry)
            return { hit: false };
        if (entry.expiresAt <= this.#now()) {
            this.#entries.delete(key);
            return { hit: false };
        }
        this.#entries.delete(key);
        this.#entries.set(key, entry);
        return { hit: true, value: structuredClone(entry.input.value) };
    }
    async write(input) {
        const snapshot = structuredClone(input);
        const key = keyOf(input.key);
        this.#entries.delete(key);
        if (input.ttlMs !== 0) {
            // Scan only under capacity pressure, before evicting a potentially live entry.
            if (this.#entries.size >= this.#maxEntries)
                this.#prune();
            this.#entries.set(key, { input: snapshot, expiresAt: input.ttlMs === undefined ? Infinity : this.#now() + input.ttlMs });
            if (this.#entries.size > this.#maxEntries)
                this.#entries.delete(this.#entries.keys().next().value);
        }
        return { written: true, key: structuredClone(input.key) };
    }
    async invalidate({ selector }) {
        const now = this.#now();
        if (selector.type === "key") {
            const key = keyOf(selector.key);
            const entry = this.#entries.get(key);
            this.#entries.delete(key);
            return { invalidated: entry && entry.expiresAt > now ? 1 : 0 };
        }
        let invalidated = 0;
        for (const [key, e] of this.#entries) {
            if (e.expiresAt <= now) {
                this.#entries.delete(key);
                continue;
            }
            if (selector.type === "tag" ? e.input.tags?.includes(selector.tag) : (e.input.key.namespace ?? "") === selector.namespace) {
                this.#entries.delete(key);
                invalidated++;
            }
        }
        return { invalidated };
    }
}
//# sourceMappingURL=provider.js.map