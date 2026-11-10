import type { DittoRuntime } from "./runtime.js";
import type { SampleInput, SampleOutput } from "../worker/infer/reasoning/sample/types.js";
import type { ActionRequest, InferCallOptions, Message, Observation, Usage } from "../worker/infer/types.js";
export interface ReactFlowInput extends SampleInput {
    constraints?: {
        maxSteps?: number;
        maxActionCalls?: number;
        maxTotalTokens?: number;
        timeoutMs?: number;
    };
}
export interface ReactFlowResult {
    result: Message;
    samples: SampleOutput[];
    observations: Observation[];
    actionRequests: ActionRequest[];
    status: "completed" | "partial" | "failed";
    stopReason: "completed" | "max_steps" | "max_action_calls" | "max_tokens" | "timeout" | "cancelled" | "dependency_failed" | "error";
    usage: Usage;
    error?: {
        code: string;
        message: string;
    };
}
/** Predefined Runtime graph flow: SAMPLE → declared action leaves → SAMPLE. Never an INFER strategy. */
export declare function runReactFlow(runtime: Pick<DittoRuntime, "run" | "services">, input: ReactFlowInput, options?: InferCallOptions & {
    graphId?: string;
}): Promise<ReactFlowResult>;
//# sourceMappingURL=react.d.ts.map