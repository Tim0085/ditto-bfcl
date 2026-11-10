import { randomUUID } from "node:crypto";
import { PayloadCodec } from "./artifact.js";
import { LocalEventFabric } from "./communication/events.js";
import { graph, runGraph } from "./graph.js";
import { runGraphPlan } from "./graph-plan.js";
import { runLoop } from "./loop.js";
import { WorkerRouter } from "./router.js";
import { createRuntimeServices } from "./services.js";
export class DittoRuntime {
    hostId;
    processId;
    services;
    #workers = new Map();
    #transports = new Map();
    #router = new WorkerRouter();
    #codec;
    #events;
    #closers = new Set();
    #closed = false;
    #closing;
    #jobs = new Set();
    #subscriptions = new Set();
    constructor(options = {}) {
        this.hostId = options.hostId ?? "local";
        this.processId = options.processId ?? randomUUID();
        this.services = createRuntimeServices(options);
        this.#codec = new PayloadCodec(options.artifacts, options.inlineLimitBytes);
        this.#events = options.events ?? new LocalEventFabric();
        for (const transport of options.transports ?? []) {
            if (!transport.id || this.#transports.has(transport.id)) {
                throw new Error(`Duplicate or empty Transport ID: ${transport.id}`);
            }
            this.#transports.set(transport.id, transport);
        }
        for (const worker of options.workers ?? [])
            this.register(worker);
    }
    register(worker, options = {}) {
        const { id: workerId = randomUUID(), services = this.services } = typeof options === "string" ? { id: options } : options;
        this.#checkId(workerId);
        const address = Object.freeze({
            workerId, workerType: worker.type, hostId: this.hostId, processId: this.processId,
        });
        const entry = {
            address, capabilities: this.#capabilities(address, worker.capabilities),
            nodeTypes: this.#capabilities(address, worker.nodeTypes ?? worker.capabilities),
            executor: worker.instantiate(), services, available: true,
            concurrency: worker.concurrency ?? Infinity, active: 0, pending: new Set(),
        };
        return this.#add(entry);
    }
    registerRemote(worker) {
        this.#checkId(worker.address.workerId);
        if (!this.#transports.has(worker.transportId)) {
            throw new Error(`Transport is not installed: ${worker.transportId}`);
        }
        if (worker.address.hostId === this.hostId && worker.address.processId === this.processId) {
            throw new Error("Use register for Workers in the current process");
        }
        if (worker.concurrency !== undefined && (!Number.isSafeInteger(worker.concurrency) || worker.concurrency < 1)) {
            throw new Error("Worker concurrency must be a positive integer");
        }
        return this.#add({
            address: Object.freeze({ ...worker.address }),
            capabilities: this.#capabilities(worker.address, worker.capabilities),
            transportId: worker.transportId, available: true,
            concurrency: worker.concurrency ?? Infinity, active: 0, pending: new Set(),
        });
    }
    workers() {
        return [...this.#workers.values()].map(({ address, capabilities, available, active, concurrency }) => ({
            address, capabilities, available, active, concurrency,
        }));
    }
    async invoke(node, input, options = {}) {
        this.#assertOpen();
        return this.#operation(() => this.#invoke(node, input, undefined, undefined, options));
    }
    async emit(event) {
        this.#assertOpen();
        return this.#operation(() => this.#events.emit(event));
    }
    subscribe(type, handler) {
        this.#assertOpen();
        const remove = this.#events.subscribe(type, event => this.#operation(async () => { await handler(event); }));
        const unsubscribe = () => { this.#subscriptions.delete(unsubscribe); return remove(); };
        this.#subscriptions.add(unsubscribe);
        return unsubscribe;
    }
    /** Wait for accepted events, returning consumer failures separately from emit. */
    drainEvents() {
        return this.#events.drain();
    }
    graph(id = "agent") {
        return graph(id);
    }
    async run(plan, input, options = {}) {
        this.#assertOpen();
        return this.#operation(() => this.#run(plan, input, options));
    }
    async loop(definition, initialState, options = {}) {
        this.#assertOpen();
        if (options.checkpoint)
            throw new Error("Use per-Graph checkpoints or a Loop stateCheckpoint");
        if ("plan" in definition && options.stateCheckpoint)
            throw new Error("Generator Loop checkpoints are unsupported; use an explicit state Loop");
        if ("plan" in definition)
            return this.#operation(() => runGraphPlan({
                ...definition,
                maxIterations: definition.maxIterations ??
                    this.services.config.loopMaxIterations,
            }, initialState, (plan, input, stepOptions) => this.#run(plan, input, {
                ...options,
                ...stepOptions,
                workers: options.workers?.[plan.id] ?? {},
                ...(options.signal
                    ? {
                        signal: stepOptions.signal
                            ? AbortSignal.any([options.signal, stepOptions.signal])
                            : options.signal,
                    }
                    : {}),
            }), options.signal, options.onGraph));
        return this.#operation(() => runLoop({
            ...definition,
            maxIterations: definition.maxIterations ?? this.services.config.loopMaxIterations,
        }, initialState, (plan, input) => this.#run(plan, input, {
            ...options,
            workers: options.workers?.[plan.id] ?? {},
        }), options.signal, options.stateCheckpoint));
    }
    #run(plan, input, options) {
        const bindings = new Map(Object.entries(options.workers ?? {}));
        const tasks = new Map(plan.tasks.map(task => [task.id, task]));
        for (const [taskId, workerId] of bindings) {
            const task = tasks.get(taskId);
            if (!task)
                throw new Error(`Unknown graph Node binding: ${taskId}`);
            if (!this.#workers.get(workerId)?.capabilities.includes(task.node)) {
                throw new Error(`Worker ${workerId} does not expose ${task.node}`);
            }
        }
        return runGraph(plan, input, (node, value, scope) => this.#invoke(node, value, undefined, scope, {
            ...(!bindings.has(scope.nodeId) ? {} : { workerId: bindings.get(scope.nodeId) }),
            ...(options.signal ? { signal: options.signal } : {}),
        }), { concurrency: this.services.config.graphConcurrency, ...options });
    }
    /** Adapter-facing receiver. This is not an unauthenticated network server. */
    async receive(envelope) {
        this.#assertOpen();
        const entry = this.#workers.get(envelope.target.workerId);
        if (!entry?.executor || !entry.available
            || entry.address.hostId !== envelope.target.hostId
            || entry.address.processId !== envelope.target.processId
            || entry.address.workerType !== envelope.target.workerType
            || !entry.capabilities.includes(envelope.node)) {
            throw new Error(`Invocation target unavailable or mismatched: ${envelope.target.workerId}`);
        }
        return this.#operation(() => this.#track(entry, async () => {
            const input = await this.#codec.decode(envelope.payload);
            const output = await entry.executor.execute(envelope.node, input, this.#context(entry, envelope.execution));
            return { invocationId: envelope.id, payload: await this.#codec.encode(output) };
        }));
    }
    async #invoke(node, input, source, execution, options = {}) {
        if (this.#closed)
            throw new Error("Runtime is closed");
        options.signal?.throwIfAborted();
        const entry = this.#router.select(node, this.#workers.values(), this.hostId, options.workerId);
        if (entry.executor) {
            return this.#track(entry, async () => {
                options.signal?.throwIfAborted();
                const result = await entry.executor.execute(node, input, this.#context(entry, execution, options.signal));
                options.signal?.throwIfAborted();
                return result;
            });
        }
        const transport = this.#transports.get(entry.transportId);
        const id = randomUUID();
        return this.#track(entry, async () => {
            const response = await transport.invoke({
                id, node, target: entry.address, payload: await this.#codec.encode(input),
                ...(source ? { source } : {}), ...(execution ? { execution } : {}),
            }, options);
            options.signal?.throwIfAborted();
            if (response.invocationId !== id)
                throw new Error("Transport returned a mismatched invocation ID");
            return this.#codec.decode(response.payload);
        });
    }
    #context(entry, execution, signal) {
        return {
            resources: undefined, config: undefined, artifacts: this.#codec.artifacts,
            services: entry.services ?? this.services, worker: entry.address, execution,
            ...(signal ? { signal } : {}),
            run: (plan, input) => {
                // Validate all capabilities before allowing any internal side effects.
                for (const task of plan.tasks) {
                    if (!entry.nodeTypes.includes(task.node))
                        throw new Error(`Worker does not implement ${task.node}`);
                }
                return runGraph(plan, input, (node, value, scope) => entry.executor.execute(node, value, this.#context(entry, scope, signal)), signal ? { signal } : {});
            },
            invoke: (node, input, options = {}) => this.#invoke(node, input, entry.address, execution, {
                ...options,
                ...(signal ? { signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal } : {}),
            }),
            emit: (event) => this.#events.emit(event),
        };
    }
    #assertOpen() {
        if (this.#closed || this.#closing)
            throw new Error("Runtime is closed");
    }
    #operation(execute) {
        const job = (async () => execute())();
        this.#jobs.add(job);
        return job.finally(() => { this.#jobs.delete(job); });
    }
    #checkId(id) {
        this.#assertOpen();
        if (!id || this.#workers.has(id))
            throw new Error(`Duplicate or empty Worker ID: ${id}`);
    }
    #capabilities(address, nodes) {
        if (!address.workerType.trim() || !nodes.length || nodes.some((node) => !/^[^.]+\..+$/.test(node))) {
            throw new Error(`Invalid capabilities for Worker ${address.workerId}`);
        }
        return Object.freeze([...new Set(nodes)]);
    }
    #add(entry) {
        this.#workers.set(entry.address.workerId, entry);
        let closing;
        const close = () => closing ??= (async () => {
            entry.available = false;
            if (this.#workers.get(entry.address.workerId) === entry)
                this.#workers.delete(entry.address.workerId);
            await Promise.allSettled(entry.pending);
            try {
                await entry.executor?.dispose?.();
            }
            finally {
                this.#closers.delete(close);
            }
        })();
        this.#closers.add(close);
        return Object.freeze({
            address: entry.address,
            setAvailable: (available) => { if (!closing)
                entry.available = available; },
            close,
            unregister: () => {
                if (this.#workers.get(entry.address.workerId) !== entry)
                    return false;
                return this.#workers.delete(entry.address.workerId);
            },
        });
    }
    #track(entry, execute) {
        if (entry.active >= entry.concurrency)
            return Promise.reject(new Error("Worker capacity exceeded"));
        entry.active++;
        const job = Promise.resolve().then(execute);
        entry.pending.add(job);
        return job.finally(() => { entry.active--; entry.pending.delete(job); });
    }
    close() {
        return this.#closing ??= (async () => {
            // Stop event intake; queued handlers and accepted graphs keep their Workers alive.
            for (const unsubscribe of this.#subscriptions)
                unsubscribe();
            await Promise.resolve();
            while (this.#jobs.size)
                await Promise.allSettled([...this.#jobs]);
            this.#closed = true;
            const results = await Promise.allSettled([...this.#closers].map(close => close()));
            const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
            if (errors.length)
                throw new AggregateError(errors, "Worker cleanup failed");
        })();
    }
}
export function createDitto(options = {}) {
    return new DittoRuntime(options);
}
//# sourceMappingURL=runtime.js.map