import { object } from "../../validation.js";
import { cacheKey } from "../schema.js";
export function validateLookup(input) { cacheKey(object(input).key); }
//# sourceMappingURL=schema.js.map