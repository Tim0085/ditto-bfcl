import { validateInvalidate } from "./schema.js";
import { abortable } from "../../validation.js";
export async function invalidateNode(input, ctx) {
    validateInvalidate(input);
    return abortable(() => ctx.cache.invalidate(input, { signal: ctx.signal }), ctx.signal);
}
//# sourceMappingURL=node.js.map