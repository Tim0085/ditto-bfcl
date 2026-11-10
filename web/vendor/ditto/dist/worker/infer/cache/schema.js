import { object, text } from "../validation.js";
export function cacheKey(value) {
    const k = object(value, "key");
    text(k.scope, "key.scope");
    text(k.key, "key.key");
    if (k.namespace !== undefined)
        text(k.namespace, "key.namespace", true);
}
//# sourceMappingURL=schema.js.map