import type { ExternalResult, JsonObject, ToolCall, ToolDefinition } from "../../../../contracts/common.js";
import type { WorkerContext } from "../../../node.js";
export type ToolExecutionOutcome = Omit<ExternalResult, "callId" | "source">;
export interface RegisteredTool extends ToolDefinition {
    validate(arguments_: JsonObject): void;
    execute(arguments_: JsonObject, context: WorkerContext<unknown, unknown>): Promise<ToolExecutionOutcome>;
}
export declare class ToolRegistry {
    #private;
    register(tool: RegisteredTool): () => boolean;
    list(context: WorkerContext<unknown, unknown>): readonly ToolDefinition[];
    call(call: ToolCall, context: WorkerContext<unknown, unknown>): Promise<ExternalResult>;
}
//# sourceMappingURL=registry.d.ts.map