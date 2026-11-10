import { createNodeScaffold } from "../../../node-scaffold.js";
export const interactionToolNode = createNodeScaffold("INTERACTION.ACT.TOOL");
export function createToolHandler(registry) {
    return (input, context) => registry.call(input.call, context);
}
//# sourceMappingURL=node.js.map