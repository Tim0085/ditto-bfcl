import type { DittoRuntime } from "../runtime.js";
import type { InvokeTransport } from "./transport.js";
/** Node child_process ChildProcess or process; the application owns process lifetime. */
export interface IpcChannel extends Pick<NodeJS.EventEmitter, "on" | "off"> {
    send?(message: object, callback?: (error: Error | null) => void): boolean;
}
export interface IpcTransportOptions {
    readonly id: string;
    readonly channel: IpcChannel;
    readonly timeoutMs?: number;
}
export interface IpcTransport extends InvokeTransport {
    /** Detach listeners and reject outstanding callers; does not kill the child. */
    close(): void;
}
/** Same-machine process transport using Node's inherited IPC channel, no TCP socket. */
export declare function createIpcTransport({ id, channel, timeoutMs }: IpcTransportOptions): IpcTransport;
/** Attach to a trusted parent/child channel. Never accepts deployment or sandbox overrides. */
export declare function serveWorkerIpc(runtime: DittoRuntime, channel: IpcChannel): {
    close(): Promise<void>;
};
//# sourceMappingURL=ipc.d.ts.map