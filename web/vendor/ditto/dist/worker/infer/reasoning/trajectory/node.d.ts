import type { InferExecution } from "../../execution.js";
import { InferError } from "../../validation.js";
import type { TrajectoryInput, TrajectoryOutput } from "./types.js";
export declare class TrajectoryFailure extends InferError {
    readonly output: TrajectoryOutput;
    constructor(code: string, message: string, output: TrajectoryOutput);
}
export declare function trajectoryNode(input: TrajectoryInput, ctx: InferExecution): Promise<TrajectoryOutput>;
export declare const inferTrajectoryNode: import("../../../node-scaffold.js").NodeScaffold<"INFER.REASONING.TRAJECTORY">;
//# sourceMappingURL=node.d.ts.map