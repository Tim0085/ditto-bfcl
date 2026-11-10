import { createNodeScaffold } from "../../node-scaffold.js";
import { validateUpdate } from "./schema.js";
export async function updateNode(input, resources, options = {}) {
    validateUpdate(input);
    return input.memories.length ? resources.store.update(input, options) : [];
}
export const memoryUpdateNode = createNodeScaffold("MEMORY.UPDATE");
//# sourceMappingURL=node.js.map