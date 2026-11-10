import type { Reference } from "../contracts/index.js";
export interface ArtifactStore {
    put(value: unknown): Promise<Reference>;
    get(reference: Reference): Promise<unknown>;
    delete(reference: Reference): Promise<boolean>;
}
/** Process-local storage. Share an external store/resolver for remote hosts. */
export declare class InMemoryArtifactStore implements ArtifactStore {
    #private;
    put(value: unknown): Promise<Reference>;
    get(reference: Reference): Promise<unknown>;
    delete(reference: Reference): Promise<boolean>;
}
export type Payload = {
    readonly kind: "inline";
    readonly value: unknown;
} | {
    readonly kind: "reference";
    readonly reference: Reference;
};
/** Used only at transport boundaries. Direct calls do not serialize or size data. */
export declare class PayloadCodec {
    readonly artifacts?: ArtifactStore | undefined;
    readonly inlineLimitBytes: number;
    constructor(artifacts?: ArtifactStore | undefined, inlineLimitBytes?: number);
    encode(value: unknown): Promise<Payload>;
    decode(payload: Payload): Promise<unknown>;
}
//# sourceMappingURL=artifact.d.ts.map