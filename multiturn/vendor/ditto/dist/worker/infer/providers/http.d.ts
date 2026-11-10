import type { ProviderConfig } from "../../../runtime/config.js";
import type { Sandbox } from "../../../runtime/sandbox/index.js";
import type { ModelProvider } from "./types.js";
export interface HttpProviderOptions extends ProviderConfig {
    sandbox: Pick<Sandbox, "assert">;
    timeoutMs?: number;
    /** Streaming only: maximum time without text, reasoning, action arguments or a result. Disabled by default. */
    idleTimeoutMs?: number;
    fetch?: typeof globalThis.fetch;
}
/** One transport and public interface, with three wire protocols and no vendor SDKs. */
export declare function createHttpProvider(options: HttpProviderOptions): ModelProvider;
//# sourceMappingURL=http.d.ts.map