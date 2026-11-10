export class NoWorkerAvailableError extends Error {
    node;
    constructor(node) {
        super(`No available Worker implements ${node}`);
        this.node = node;
        this.name = "NoWorkerAvailableError";
    }
}
/** Filters actual capability/availability, then direct > same host > remote. */
export class WorkerRouter {
    #next = new Map();
    select(node, entries, hostId, workerId) {
        let priority = Infinity;
        const pool = [];
        for (const entry of entries) {
            if (workerId !== undefined && entry.address.workerId !== workerId)
                continue;
            if (!entry.available || entry.active >= entry.concurrency || !entry.capabilities.includes(node))
                continue;
            const rank = entry.executor ? 0 : entry.address.hostId === hostId ? 1 : 2;
            if (rank < priority) {
                priority = rank;
                pool.length = 0;
            }
            if (rank === priority)
                pool.push(entry);
        }
        if (!pool.length)
            throw new NoWorkerAvailableError(node);
        const index = (this.#next.get(node) ?? 0) % pool.length;
        this.#next.set(node, (index + 1) % pool.length);
        return pool[index];
    }
}
//# sourceMappingURL=router.js.map