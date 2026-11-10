import type { ReflectInput, ReflectOutput } from "./types.js";
export declare function validateReflect(input: unknown): asserts input is ReflectInput;
export declare function validateReflectOutput(v: Record<string, unknown>, mode: ReflectInput["mode"]): asserts v is Record<string, unknown> & ReflectOutput;
//# sourceMappingURL=schema.d.ts.map