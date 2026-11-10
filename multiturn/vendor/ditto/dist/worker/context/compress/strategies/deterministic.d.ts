import type { Context } from "../../../../contracts/common.js";
import type { ContextExecution } from "../../types.js";
import type { ContextCompressInput } from "../types.js";
export { isProtectedContextItem } from "../../protection.js";
/** Deterministic budget enforcement. Tool-correlated entries are atomic groups. */
export declare function deterministicCompress(input: ContextCompressInput, execution: ContextExecution): Promise<Context>;
//# sourceMappingURL=deterministic.d.ts.map