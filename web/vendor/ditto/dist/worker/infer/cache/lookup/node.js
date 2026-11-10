import { validateLookup } from "./schema.js";
import { abortable } from "../../validation.js";
export async function lookupNode(input, ctx) {
    validateLookup(input);
    return abortable(() => ctx.cache.lookup(input, { signal: ctx.signal }), ctx.signal);
}
//# sourceMappingURL=node.js.map