import type { ExternalResult, InteractionError, JsonValue, OutputReceipt } from "../../contracts/common.js";
import type { InteractionMcpInput, InteractionOutputInput } from "./contracts.js";
export declare function nonempty(value: unknown, name: string): asserts value is string;
export declare function jsonValue(value: unknown, name: string, seen?: Set<object>): asserts value is JsonValue;
export declare function validateMcpInput(value: unknown): asserts value is InteractionMcpInput;
export declare function validateOutputInput(value: unknown): asserts value is InteractionOutputInput;
export declare function interactionError(value: unknown): InteractionError;
export declare function externalResult(value: unknown, errorFallback?: InteractionError): ExternalResult;
export declare function outputReceipt(value: unknown): OutputReceipt;
//# sourceMappingURL=validation.d.ts.map