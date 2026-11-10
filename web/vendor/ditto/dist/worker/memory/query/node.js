import { createNodeScaffold } from "../../node-scaffold.js";
import { validateQuery } from "./schema.js";
export async function queryNode(input, resources, options = {}) {
    validateQuery(input);
    return resources.store.query(input, options);
}
export const memoryQueryNode = createNodeScaffold("MEMORY.QUERY");
//# sourceMappingURL=node.js.map