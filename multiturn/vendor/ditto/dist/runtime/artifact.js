import { randomUUID } from "node:crypto";
/** Process-local storage. Share an external store/resolver for remote hosts. */
export class InMemoryArtifactStore {
    #values = new Map();
    async put(value) {
        const uri = `ditto://artifact/${randomUUID()}`;
        this.#values.set(uri, value);
        return { uri };
    }
    async get(reference) {
        if (!this.#values.has(reference.uri)) {
            throw new Error(`Artifact not found: ${reference.uri}`);
        }
        return this.#values.get(reference.uri);
    }
    async delete(reference) {
        return this.#values.delete(reference.uri);
    }
}
/** Used only at transport boundaries. Direct calls do not serialize or size data. */
export class PayloadCodec {
    artifacts;
    inlineLimitBytes;
    constructor(artifacts, inlineLimitBytes = 64 * 1024) {
        this.artifacts = artifacts;
        this.inlineLimitBytes = inlineLimitBytes;
        if (!Number.isFinite(inlineLimitBytes) || inlineLimitBytes < 0) {
            throw new Error("inlineLimitBytes must be finite and non-negative");
        }
    }
    async encode(value) {
        if (this.artifacts) {
            const json = JSON.stringify(value);
            if (json !== undefined && Buffer.byteLength(json, "utf8") > this.inlineLimitBytes) {
                return { kind: "reference", reference: await this.artifacts.put(value) };
            }
        }
        return { kind: "inline", value };
    }
    async decode(payload) {
        if (payload.kind === "inline")
            return payload.value;
        if (payload.kind !== "reference")
            throw new Error("Unsupported payload kind");
        if (!this.artifacts)
            throw new Error("Reference payload requires an ArtifactStore");
        return this.artifacts.get(payload.reference);
    }
}
//# sourceMappingURL=artifact.js.map