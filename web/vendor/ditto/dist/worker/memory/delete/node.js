import { createNodeScaffold } from "../../node-scaffold.js";
import { validateDelete } from "./schema.js";
export async function deleteNode(input, resources, options = {}) {
    validateDelete(input);
    const ids = [...new Set(input.ids)];
    return ids.length ? resources.store.delete({ ids }, options) : { deleted: [] };
}
export const memoryDeleteNode = createNodeScaffold("MEMORY.DELETE");
//# sourceMappingURL=node.js.map