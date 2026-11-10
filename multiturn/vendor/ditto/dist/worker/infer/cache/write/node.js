import { validateWrite } from "./schema.js";
import { abortable } from "../../validation.js";
export async function writeNode(input, ctx) {
    validateWrite(input);
    return abortable(() => ctx.cache.write(input, { signal: ctx.signal }), ctx.signal);
}
//# sourceMappingURL=node.js.map