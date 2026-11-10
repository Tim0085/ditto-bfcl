import { AsyncLocalStorage } from "node:async_hooks";
import { connectRetryScope } from "./model-client.ts";
import { failureOrigin, aggregateDetails, cleanupScope, type CleanupCapture } from "./step-log.ts";
import { createDitto, loadRuntimeConfig } from "@codesoul-co/ditto";
import { serveWorkerIpc, type InvocationEnvelope } from "@codesoul-co/ditto/runtime";
import { createAgentCoreWorker, CAPABILITIES, AGENT_CORE_NODES, type Capability, type AgentCoreInstanceHandle } from "./agent-core.ts";
import { stamp, log, errorText, taskFrom, scoringFields, recordingFailures } from "./step-log.ts";

export interface HostOptions {
  id: string; role: Capability | "All"; python: string; memoryDirectory: string; modelEndpoint: string;
  inferenceTimeoutMs: number; stepFile: string; serviceFile: string;
}
/** Management and invocation admission share one FIFO, including payload decoding.
 * Enqueue at receive (before its async decode) so cleanup cannot overtake a received step. */
export class HostQueue {
  private tail = Promise.resolve();
  stopped = false;
  enqueue<T>(work: () => Promise<T>, management = false): Promise<T> {
    const job = this.tail.then(() => { if (this.stopped && !management) throw new Error("Worker stopped accepting work"); return work(); });
    this.tail = job.then(() => {}, () => {}); return job;
  }
  drain() { return this.tail; }
}
export async function host(options: HostOptions) {
  if (!process.send) throw new Error("worker-host requires IPC");
  const queue = new HostQueue();
  const scope = new AsyncLocalStorage<{ envelope: InvocationEnvelope; row: any }>();
  let handle: AgentCoreInstanceHandle | undefined;
  const runtime = createDitto({ config: loadRuntimeConfig({}) });
  const definition = createAgentCoreWorker({ ...options, onInstance: h => handle = h,
    onServiceCreated: capability => log(options.serviceFile, { workerId: options.id, pid: process.pid, capability, at: stamp() }) });
  const capabilities = options.role === "All" ? AGENT_CORE_NODES : CAPABILITIES[options.role];
  const registered = runtime.register({ ...definition, capabilities, instantiate() {
    const executor = definition.instantiate();
    return { dispose: () => executor.dispose?.(), async execute(node, input, ctx) {
      const row = scope.getStore()!.row;
      row.taskId = taskFrom(input); row.execution = ctx.execution ?? null;
      row.started = stamp(); const cpu = process.cpuUsage();
      try {
        const work = () => executor.execute(node, input, ctx);
        const result: any = await (node === "INFER.REASONING.SAMPLE"
          ? connectRetryScope.run(Object.assign(row, { connectRetries: 0, connectRetryWaitMs: 0 }), work) : work());
        Object.assign(row,scoringFields(node,input,result));
        row.success = result?.status === undefined || result.status === "success";
        row.error = result?.error?.message ?? null;
        row.pythonPid = result?.structuredContent?.pythonPid ?? result?.metadata?.pythonPid ?? null;
        if (node === "INFER.REASONING.SAMPLE") row.modelTiming = result?.output?.message?.metadata?.modelTiming ?? null;
        return result;
      } catch (error) { row.success = false; row.error = errorText(error); throw error; }
      finally { row.ended = stamp(); row.cpu = process.cpuUsage(cpu); row.rss = process.memoryUsage().rss; }
    } };
  } }, { id: options.id });
  // Retain Ditto's IPC protocol and payload codec; only control local admission.
  const originalReceive = runtime.receive.bind(runtime);
  runtime.receive = (envelope) => {
    const row: any = { invocationId: envelope.id, workerId: options.id, pid: process.pid, node: envelope.node,
      taskId: null, execution: envelope.execution ?? null, received: stamp(), started: null, ended: null, success: false, error: null };
    return queue.enqueue(() => scope.run({ envelope, row }, () => originalReceive(envelope)))
      .catch(async error => {
        row.error ??= errorText(error);
        const failureType=failureOrigin(error);
        // Send before the SDK rejection reply, which intentionally omits the original error.
        if(failureType&&process.connected)await new Promise<void>(resolve=>process.send!({
          protocol:"bfcl:manage:1",kind:"failure-origin",id:envelope.id,workerId:options.id,pid:process.pid,failureType
        },()=>resolve()));
        throw error;
      })
      .finally(() => log(options.stepFile, row));
  };
  const server = serveWorkerIpc(runtime, process);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    queue.stopped = true;
    await server.close(); await queue.drain(); await runtime.close();
    if(process.connected)await new Promise<void>(resolve=>process.send!({protocol:"bfcl:manage:1",kind:"recording-failures",failures:recordingFailures()},()=>resolve()));
    if (process.connected) process.disconnect();
  })();
  process.on("message", (message: any) => {
    if (message?.protocol !== "bfcl:manage:1") return;
    // Liveness is independent of the work FIFO: another task may still be waiting on a model.
    if (message.kind === "ping" && process.connected) process.send!({
      protocol: "bfcl:manage:1", kind: "pong", id: message.id, workerId: options.id, pid: process.pid, at: stamp()
    }, () => {});
    if (message.kind === "stop") queue.stopped = true;
    if (message.kind === "shutdown") void close().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
    if (message.kind === "release") {
      const capture:CleanupCapture={};
      void cleanupScope.run(capture,()=>queue.enqueue(async () => handle!.releaseTask(message.taskId), true))
      .then(result => ({ result }), error => {
        const details=aggregateDetails(error);
        return {error:errorText(error),...(details?{aggregateError:details}:{}),...(capture.sources?{cleanupSources:capture.sources}:{})};
      })
      .then(reply => { if (process.connected) process.send!({ protocol: "bfcl:manage:1", kind: "released", id: message.id, ...reply }, () => {}); });
    }
  });
  process.once("disconnect", () => { void close().catch(error => { console.error(errorText(error)); process.exitCode = 1; }); });
  process.send({ protocol: "bfcl:manage:1", kind: "ready", address: registered.address, capabilities,
    pid: process.pid, at: stamp(), envNames: Object.keys(process.env).sort() });
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/worker-host.ts")) await host(JSON.parse(process.argv[2]));
