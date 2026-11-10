export function defineNode(workerType, type, execute) {
    if (typeof workerType !== "string" || !workerType.trim())
        throw new Error("Node requires an owning Worker type");
    if (typeof type !== "string" || !/^[^.\s]+(?:\.[^.\s]+)+$/.test(type)) {
        throw new Error("Node type must be a fully qualified leaf name");
    }
    if (typeof execute !== "function")
        throw new Error(`Missing handler for ${type}`);
    return Object.freeze({ workerType, type, execute });
}
//# sourceMappingURL=node.js.map