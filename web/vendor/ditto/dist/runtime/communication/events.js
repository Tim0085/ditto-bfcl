export class LocalEventFabric {
    #handlers = new Map();
    #pending = new Set();
    #failures = [];
    async emit(event) {
        // Snapshot subscribers; one failure must not block any other consumer.
        for (const handler of [...(this.#handlers.get(event.type) ?? [])]) {
            const task = Promise.resolve()
                .then(() => handler(event))
                .catch((error) => { this.#failures.push({ event, error }); });
            this.#pending.add(task);
            void task.then(() => { this.#pending.delete(task); });
        }
    }
    subscribe(type, handler) {
        const handlers = this.#handlers.get(type) ?? new Set();
        // A distinct wrapper gives each subscription independent ownership.
        const subscriber = (event) => handler(event);
        handlers.add(subscriber);
        this.#handlers.set(type, handlers);
        return () => {
            const removed = handlers.delete(subscriber);
            if (removed && handlers.size === 0 && this.#handlers.get(type) === handlers) {
                this.#handlers.delete(type);
            }
            return removed;
        };
    }
    async drain() {
        while (this.#pending.size)
            await Promise.all([...this.#pending]);
        return this.#failures.splice(0);
    }
}
//# sourceMappingURL=events.js.map