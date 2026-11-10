import { createNodeScaffold } from "../../node-scaffold.js";
import { validateWrite } from "./schema.js";
export async function writeNode(input, resources, options = {}) {
    validateWrite(input);
    return input.memories.length ? resources.store.write(input, options) : [];
}
export const memoryWriteNode = createNodeScaffold("MEMORY.WRITE");
//# sourceMappingURL=node.js.map