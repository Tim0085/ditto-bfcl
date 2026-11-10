import { createNodeScaffold } from "../node-scaffold.js";
import { validateOutputInput, outputReceipt } from "./validation.js";
export const interactionOutputNode = createNodeScaffold("INTERACTION.OUTPUT");
export function createOutputHandler(sink) {
    return async (input, context) => {
        validateOutputInput(input);
        const receipt = outputReceipt(await sink.deliver(input, context));
        if (receipt.deliveryId !== input.deliveryId)
            throw new Error("Output receipt deliveryId mismatch");
        return receipt;
    };
}
//# sourceMappingURL=output.js.map