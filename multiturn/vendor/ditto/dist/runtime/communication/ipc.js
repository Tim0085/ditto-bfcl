const protocol = "ditto:invoke:1";
function packet(value) {
    return !!value && typeof value === "object" && "protocol" in value && value.protocol === protocol
        && "id" in value && typeof value.id === "string" && value.id !== ""
        && "kind" in value && (value.kind === "request" || value.kind === "response");
}
function send(channel, value) {
    return new Promise((resolve, reject) => {
        if (!channel.send) {
            reject(new Error("IPC channel is not connected"));
            return;
        }
        // false means queued, not failed; the callback reports delivery to the channel.
        channel.send(value, error => { if (error)
            reject(error);
        else
            resolve(); });
    });
}
/** Same-machine process transport using Node's inherited IPC channel, no TCP socket. */
export function createIpcTransport({ id, channel, timeoutMs = 30_000 }) {
    if (!id || !channel.send)
        throw new Error("IPC requires an ID and a connected channel");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
        throw new Error("IPC timeoutMs must be between 1 and 2147483647");
    }
    const pending = new Map();
    let closed = false;
    const onMessage = (value) => {
        if (!packet(value) || value.kind !== "response")
            return;
        const job = pending.get(value.id);
        if (!job)
            return;
        if (value.error)
            job.reject(new Error(value.error));
        else if (value.result?.invocationId === value.id && value.result.payload)
            job.resolve(value.result);
        else
            job.reject(new Error("Invalid IPC result"));
    };
    const close = () => {
        if (closed)
            return;
        closed = true;
        channel.off("message", onMessage);
        channel.off("disconnect", close);
        for (const job of pending.values())
            job.reject(new Error("IPC transport is closed"));
    };
    channel.on("message", onMessage);
    channel.on("disconnect", close);
    return {
        id, close,
        invoke(envelope, options) {
            if (closed)
                return Promise.reject(new Error("IPC transport is closed"));
            if (options?.signal?.aborted)
                return Promise.reject(options.signal.reason);
            if (pending.has(envelope.id))
                return Promise.reject(new Error("Duplicate IPC invocation ID"));
            return new Promise((resolve, reject) => {
                const finish = (error, result) => {
                    if (!pending.delete(envelope.id))
                        return;
                    clearTimeout(timer);
                    options?.signal?.removeEventListener("abort", abort);
                    if (result)
                        resolve(result);
                    else
                        reject(error);
                };
                const abort = () => finish(options?.signal?.reason);
                const timer = setTimeout(() => finish(new Error("IPC invocation timed out")), timeoutMs);
                pending.set(envelope.id, { resolve: result => finish(undefined, result), reject: error => finish(error) });
                options?.signal?.addEventListener("abort", abort, { once: true });
                void send(channel, { protocol, kind: "request", id: envelope.id, envelope }).catch(error => finish(error));
            });
        },
    };
}
/** Attach to a trusted parent/child channel. Never accepts deployment or sandbox overrides. */
export function serveWorkerIpc(runtime, channel) {
    if (!channel.send)
        throw new Error("IPC channel is not connected");
    const pending = new Set();
    const onMessage = (value) => {
        if (!packet(value) || value.kind !== "request")
            return;
        const job = (async () => {
            let response;
            try {
                if (!value.envelope || value.envelope.id !== value.id)
                    throw new Error("Invalid IPC invocation");
                response = { protocol, kind: "response", id: value.id, result: await runtime.receive(value.envelope) };
            }
            catch {
                response = { protocol, kind: "response", id: value.id, error: "Worker invocation failed" };
            }
            // A disconnected caller cannot receive the result; local execution is already settled.
            await send(channel, response).catch(() => { });
        })();
        pending.add(job);
        void job.finally(() => { pending.delete(job); });
    };
    channel.on("message", onMessage);
    return { async close() { channel.off("message", onMessage); await Promise.all([...pending]); } };
}
//# sourceMappingURL=ipc.js.map