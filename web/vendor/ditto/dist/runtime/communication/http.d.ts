import type { RequestListener } from "node:http";
import type { DittoRuntime } from "../runtime.js";
import type { InvokeTransport } from "./transport.js";
export interface HttpTransportOptions {
    readonly id: string;
    /** Full endpoint, e.g. https://worker.internal/ditto/invoke. */
    readonly url: string;
    readonly token: string;
    readonly timeoutMs?: number;
    readonly maxBodyBytes?: number;
}
export declare function createHttpTransport(options: HttpTransportOptions): InvokeTransport;
/** Mount on a Node HTTP(S) server. Token authorizes all locally registered capabilities. */
export declare function createWorkerHttpHandler(runtime: DittoRuntime, options: {
    token: string;
    maxBodyBytes?: number;
}): RequestListener;
//# sourceMappingURL=http.d.ts.map