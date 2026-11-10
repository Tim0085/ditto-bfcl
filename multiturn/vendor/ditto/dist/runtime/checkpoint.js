import { createHash } from "node:crypto";
export function stateDigest(value) {
    const visiting = new Set();
    const encode = (v) => {
        if (v === null || typeof v === "string" || typeof v === "boolean")
            return JSON.stringify(v);
        if (typeof v === "number" && Number.isFinite(v))
            return JSON.stringify(v);
        if (!v || typeof v !== "object" || visiting.has(v))
            throw new Error("Checkpoint state must be acyclic JSON");
        if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
            throw new Error("Checkpoint state cannot contain live resources or class instances");
        visiting.add(v);
        const result = Array.isArray(v) ? `[${Array.from(v, encode).join(",")}]`
            : `{${Object.keys(v).sort().filter(k => v[k] !== undefined)
                .map(k => `${JSON.stringify(k)}:${encode(v[k])}`).join(",")}}`;
        visiting.delete(v);
        return result;
    };
    return createHash("sha256").update(encode(value)).digest("hex");
}
export function checkpointState(scope, version, state) {
    if (!scope.trim() || !version.trim())
        throw new Error("Checkpoint scope and version are required");
    const digest = stateDigest({ scope, version, state });
    return { format: 1, scope, version, state: JSON.parse(JSON.stringify(state)), digest };
}
export function restoreState(checkpoint, scope, version) {
    if (checkpoint.format !== 1 || checkpoint.scope !== scope || checkpoint.version !== version
        || checkpoint.digest !== stateDigest({ scope, version, state: checkpoint.state }))
        throw new Error("Checkpoint scope, version or integrity mismatch");
    return JSON.parse(JSON.stringify(checkpoint.state));
}
export class UncertainGraphCheckpointError extends Error {
    checkpoint;
    code = "UNCERTAIN_GRAPH_OPERATIONS";
    constructor(checkpoint) {
        super(`Graph checkpoint has uncertain operations: ${checkpoint.state.uncertain.join(", ")}`);
        this.checkpoint = checkpoint;
        this.name = "UncertainGraphCheckpointError";
    }
}
/** Host-only reconciliation after checking external effects. Never retries implicitly. */
export function reconcileGraphCheckpoint(checkpoint, resolutions) {
    const state = restoreState(checkpoint, checkpoint.scope, checkpoint.version);
    const outputs = Object.assign(Object.create(null), state.outputs);
    const pending = new Set(state.uncertain);
    for (const [id, resolution] of Object.entries(resolutions)) {
        if (!pending.has(id))
            throw new Error(`Operation is not uncertain: ${id}`);
        if (Object.hasOwn(resolution, "output") && Object.keys(resolution).length === 1 && resolution.output !== undefined)
            outputs[id] = resolution.output;
        else if (!("retry" in resolution) || resolution.retry !== true || Object.keys(resolution).length !== 1)
            throw new Error(`Invalid operation resolution: ${id}`);
        pending.delete(id);
    }
    return checkpointState(checkpoint.scope, checkpoint.version, { ...state, outputs, uncertain: [...pending] });
}
//# sourceMappingURL=checkpoint.js.map