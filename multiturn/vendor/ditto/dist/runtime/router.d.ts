import type { NodeType } from "../contracts/index.js";
import type { WorkerExecutor } from "../worker/define-worker.js";
import type { RuntimeServices } from "./services.js";
import type { WorkerAddress } from "./communication/transport.js";
export interface WorkerEntry {
    readonly address: WorkerAddress;
    readonly capabilities: readonly NodeType[];
    readonly nodeTypes?: readonly NodeType[];
    readonly executor?: WorkerExecutor;
    readonly services?: RuntimeServices;
    readonly transportId?: string;
    available: boolean;
    readonly concurrency: number;
    active: number;
    readonly pending: Set<Promise<unknown>>;
}
export declare class NoWorkerAvailableError extends Error {
    readonly node: NodeType;
    constructor(node: NodeType);
}
/** Filters actual capability/availability, then direct > same host > remote. */
export declare class WorkerRouter {
    #private;
    select(node: NodeType, entries: Iterable<WorkerEntry>, hostId: string, workerId?: string): WorkerEntry;
}
//# sourceMappingURL=router.d.ts.map