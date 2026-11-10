export class AgentValidationError extends Error {
    diagnostic;
    constructor(path, message, code = "INVALID_VALUE") {
        super(`Agent ${path || "definition"}: ${message}`);
        this.name = "AgentValidationError";
        const parts = path.split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"));
        this.diagnostic = { code, path, message, ...(parts[1] === "graphs" && parts[2] ? { graphId: parts[2] } : {}) };
        if (parts[1] === "deployment" && parts[2] === "bindings" && parts[3])
            Object.assign(this.diagnostic, { graphId: parts[3], ...(parts[4] ? { nodeId: parts[4] } : {}) });
    }
}
export function pointer(base, key) {
    return `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}
//# sourceMappingURL=agent-diagnostics.js.map