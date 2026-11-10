import { createNodeScaffold } from "../../node-scaffold.js";
import { validateOutput } from "../validation.js";
import { validateGet } from "./schema.js";
export async function getNode(input, resources, options = {}) {
    validateGet(input);
    const ids = [...new Set(input.ids ?? [])];
    const keys = [...new Set(input.keys ?? [])];
    if (!ids.length && !keys.length)
        return [];
    const items = await resources.store.get({ ids, keys }, options);
    validateOutput("get", items);
    const byId = new Map(items.map(item => [item.id, item]));
    const byKey = new Map(items.filter(item => item.key !== undefined).map(item => [item.key, item]));
    const selected = new Map();
    for (const item of [...ids.map(id => byId.get(id)), ...keys.map(key => byKey.get(key))]) {
        if (item)
            selected.set(item.id, item);
    }
    return [...selected.values()];
}
export const memoryGetNode = createNodeScaffold("MEMORY.GET");
//# sourceMappingURL=node.js.map