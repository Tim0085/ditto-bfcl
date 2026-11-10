import type { ContextItem, JsonObject, MessageContent, Reference } from "../../../../contracts/common.js";
import type { ContextRagStrategy, ContextCallOptions } from "../../types.js";
export interface RagCandidate {
    readonly item: ContextItem;
    readonly score?: number;
    readonly metadata?: JsonObject;
}
export interface RagEmbedInput {
    readonly query?: MessageContent;
    readonly items: readonly ContextItem[];
    readonly corpus?: Reference;
    readonly options?: JsonObject;
}
export interface RagRetrieveInput extends RagEmbedInput {
    readonly embedding?: unknown;
}
export interface RagRankInput extends RagEmbedInput {
    readonly candidates: readonly RagCandidate[];
}
export interface RagEmbedStep {
    embed(input: RagEmbedInput, options?: ContextCallOptions): Promise<unknown>;
}
export interface RagRetrieveStep {
    retrieve(input: RagRetrieveInput, options?: ContextCallOptions): Promise<readonly RagCandidate[]>;
}
export interface RagRankStep {
    rank(input: RagRankInput, options?: ContextCallOptions): Promise<readonly RagCandidate[]>;
}
export interface RagPipeline {
    readonly embed?: RagEmbedStep;
    readonly retrieve: RagRetrieveStep;
    readonly rank?: RagRankStep;
}
/** Creates an internal SELECT strategy; embed/retrieve/rank are never registered as Nodes. */
export declare function createRagStrategy(pipeline: RagPipeline): ContextRagStrategy;
//# sourceMappingURL=rag.d.ts.map