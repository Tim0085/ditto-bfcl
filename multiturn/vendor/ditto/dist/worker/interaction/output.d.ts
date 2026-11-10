import type { OutputReceipt } from "../../contracts/common.js";
import type { WorkerContext } from "../node.js";
import type { InteractionOutputInput } from "./contracts.js";
export declare const interactionOutputNode: import("../node-scaffold.js").NodeScaffold<"INTERACTION.OUTPUT">;
export interface OutputSink {
    deliver(input: InteractionOutputInput, context: WorkerContext<unknown, unknown>): Promise<OutputReceipt>;
}
export declare function createOutputHandler<R = undefined, C = undefined>(sink: OutputSink): import("../node.js").NodeHandler<"INTERACTION.OUTPUT", R, C>;
//# sourceMappingURL=output.d.ts.map