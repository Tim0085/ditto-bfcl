import { defineNode } from "./node.js";
export function createNodeScaffold(type) {
    return Object.freeze({
        type,
        define(workerType, execute) {
            return defineNode(workerType, type, execute);
        },
    });
}
//# sourceMappingURL=node-scaffold.js.map