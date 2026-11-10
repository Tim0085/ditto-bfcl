/** Creates an internal SELECT strategy; embed/retrieve/rank are never registered as Nodes. */
export function createRagStrategy(pipeline) {
    return Object.freeze({
        async select(input, options = {}) {
            options.signal?.throwIfAborted();
            const strategy = input.strategy?.kind === "rag" ? input.strategy : { kind: "rag" };
            const base = {
                items: input.context.items,
                ...(input.query === undefined ? {} : { query: input.query }),
                ...(strategy.corpus === undefined ? {} : { corpus: strategy.corpus }),
                ...(strategy.options === undefined ? {} : { options: strategy.options }),
            };
            const embedding = await pipeline.embed?.embed(base, options);
            options.signal?.throwIfAborted();
            const retrieved = await pipeline.retrieve.retrieve({
                ...base,
                ...(embedding === undefined ? {} : { embedding }),
            }, options);
            options.signal?.throwIfAborted();
            const ranked = pipeline.rank ? await pipeline.rank.rank({ ...base, candidates: retrieved }, options) : retrieved;
            options.signal?.throwIfAborted();
            const unique = new Map();
            for (const candidate of ranked)
                if (!unique.has(candidate.item.id))
                    unique.set(candidate.item.id, candidate.item);
            return [...unique.values()];
        },
    });
}
//# sourceMappingURL=rag.js.map