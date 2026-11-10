import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createDitto, loadRuntimeConfig } from "@codesoul-co/ditto";
import { createIpcTransport, type InvokeTransport, type WorkerAddress } from "@codesoul-co/ditto/runtime";
import { CAPABILITIES, AGENT_CORE_NODES, CONTEXT_POLICY, type Capability, type AgentCoreInstanceHandle } from "./agent-core.ts";
import { createBindings, type Assignment, type Group } from "./bindings.ts";
import { STAGES, graphId, type Stage } from "./graphs.ts";
import { deployTimeouts } from "./deploy-timeouts.ts";
import { useLeastQueued } from "./least-queued.ts";
import { stamp, log, auxiliaryJson, errorText, taskFrom, milliseconds, captureScoring } from "./step-log.ts";
import { markFailure, isFailureType, cleanupReplyError, type FailureType } from "./step-log.ts";
import { InputLimit } from "./egress/retry.ts";
import { SEARCH_RUN_STOP_PREFIX, toolInvocationIdentity } from "./worker-host.ts";

function restoreToolFailure(details: unknown, toolName: unknown) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return;
  const value = details as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "input_limit" && keys === "inputBytes,kind,maxRequestBytes" &&
      typeof value.inputBytes === "number" && Number.isSafeInteger(value.inputBytes) &&
      value.maxRequestBytes === CONTEXT_POLICY.maxInlineBytes && value.inputBytes > value.maxRequestBytes) {
    return new InputLimit(value.inputBytes, value.maxRequestBytes);
  }
  if (value.kind === "run_stop" && keys === "kind,message" && toolName === "search_engine_query" &&
      typeof value.message === "string") {
    return new Error(SEARCH_RUN_STOP_PREFIX + value.message);
  }
}

export type Copies = { All: number } | Record<Capability, number>;
export interface DeployOptions {
  group: Group; copies: Copies; python: string; modelEndpoint: string; directory: string;
  timeouts: ReturnType<typeof deployTimeouts>; startupConcurrency?: number;
  onStop?: (reason: string) => void;
}
export function childEnvironment(env = process.env): NodeJS.ProcessEnv {
  const names = ["PATH", "SYSTEMROOT", "NODE_OPTIONS", "OFFLINE_GUARD_REPORT_DIR", "TEMP", "TMP", "TMPDIR"];
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => names.includes(key.toUpperCase()))), PYTHONDONTWRITEBYTECODE: "1" };
}
export function layout(group: Group, copies: Copies) {
  if (group === "Monolithic" && (!('All' in copies) || Object.keys(copies).length !== 1)) throw new Error("Monolithic requires All copies");
  if (group !== "Monolithic" && Object.keys(copies).sort().join() !== Object.keys(CAPABILITIES).sort().join()) throw new Error("Four capability counts required");
  const counts = Object.values(copies);
  if (counts.some(n => !Number.isSafeInteger(n) || n < 1) || counts.reduce((a,b) => a+b,0) > 32) throw new Error("Invalid worker counts");
  if (group === "Uniform" && new Set(counts).size !== 1) throw new Error("Uniform counts must be equal");
  return Object.entries(copies).flatMap(([role, count]) => Array.from({length: count}, (_, i) => ({ id: `${role}-${i+1}`, role: role as Capability | "All" })));
}
export function verifyBindings(group:Group, assignment:Assignment, bindings:ReturnType<typeof createBindings>, workers:readonly {address:WorkerAddress;capabilities:readonly string[]}[]) {
  const expected=createBindings(group,assignment);
  for(const [stage,steps] of Object.entries(STAGES))for(const step of steps){
    const graph=graphId(stage as Stage),wanted=expected[graph][step.id],actual=bindings[graph]?.[step.id];
    if(wanted!==actual)throw new Error(`Invalid binding ${graph}.${step.id}: expected ${wanted}, actual ${actual}`);
    if(actual&&!workers.some(w=>w.address.workerId===actual&&w.capabilities.includes(step.node)))throw new Error(`Binding lacks capability ${graph}.${step.id}`);
  }
}
export async function deploy(options: DeployOptions, makeTransport:typeof createIpcTransport=createIpcTransport) {
  const started = stamp(), specs = layout(options.group, options.copies);
  mkdirSync(join(options.directory,"workers"), { recursive:true });
  const units: {id:string;role:Capability|"All";child:ChildProcess;exited:Promise<void>;dead:boolean;assigned:number;ready?:any}[] = [];
  const transports: ReturnType<typeof createIpcTransport>[] = [];
  const workerRecordingFailures:Record<string,unknown>={};
  let stopped: string | undefined, closing = false, closePromise: Promise<void> | undefined;
  let runtime: ReturnType<typeof createDitto> | undefined;
  let startupEnded = started;
  const notify = (child: ChildProcess, kind: string) => { if (child.connected) child.send({protocol:"bfcl:manage:1",kind}, () => {}); };
  const stop = (reason: string) => { if (stopped) return; stopped = reason; for (const u of units) notify(u.child,"stop"); options.onStop?.(reason); };
  async function close() {
    return closePromise ??= (async () => {
      closing = true; const shutdownStarted = stamp();
      try { await runtime?.close(); }
      finally {
        await Promise.all(units.map(async u => {
          if (u.dead) return;
          notify(u.child,"shutdown");
          const timer = setTimeout(() => u.child.kill("SIGKILL"), options.timeouts.shutdownTimeoutMs);
          try { await u.exited; } finally { clearTimeout(timer); }
        }));
        transports.forEach(t => t.close());
        const shutdownEnded = stamp();
        auxiliaryJson(join(options.directory,"lifecycle.json"), { started, startupEnded, startupMs:milliseconds(startupEnded,started),
          shutdownStarted, shutdownEnded, shutdownMs:milliseconds(shutdownEnded,shutdownStarted), stopReason:stopped??null,
          processes:units.map(u => ({id:u.id,role:u.role,pid:u.child.pid,ready:u.ready??null,exited:u.dead})) });
      }
    })();
  }
  let index = 0, startupError: unknown;
  async function startNext() {
    while (index < specs.length && !startupError && !stopped) {
      const spec = specs[index++];
      const child = fork(fileURLToPath(new URL("./worker-host.ts",import.meta.url)), [JSON.stringify({...spec,python:options.python,
        modelEndpoint:options.modelEndpoint,inferenceTimeoutMs:options.timeouts.inferenceTimeoutMs,
        memoryDirectory:join(options.directory,"memory",spec.id),stepFile:join(options.directory,"workers",spec.id+".steps.jsonl"),
        serviceFile:join(options.directory,"workers",spec.id+".services.jsonl")})],
        { windowsHide:true,stdio:["ignore","ignore","pipe","ipc"],env:childEnvironment(),execArgv:["--experimental-transform-types"] });
      const u = {...spec,child,dead:false,assigned:0,exited:Promise.resolve(),ready:undefined as any};
      u.exited = new Promise<void>(resolve => child.once("exit", () => { u.dead=true; resolve(); if(!closing) stop(`Worker 退出：${u.id}`); }));
      child.on("disconnect", () => { if(!closing) stop(`Worker 退出：${u.id} IPC disconnected`); });
      child.on("message",(m:any)=>{if(m?.protocol==="bfcl:manage:1"&&m.kind==="recording-failures")workerRecordingFailures[u.id]=m.failures;});
      child.stderr?.on("data", bytes => log(join(options.directory,"workers",spec.id+".stderr.jsonl"),{text:bytes.toString()}));
      units.push(u);
      try {
        u.ready = await new Promise<any>((resolve,reject) => {
          const finish = (error?:unknown,value?:any) => { clearTimeout(timer); child.off("message",message);child.off("error",failed);child.off("exit",failedExit); error?reject(error):resolve(value); };
          const message = (value:any) => { if(value?.protocol==="bfcl:manage:1"&&value.kind==="ready")finish(undefined,value); };
          const failed = (error:Error) => finish(error), failedExit = () => finish(new Error("Worker exited before ready"));
          const timer=setTimeout(()=>finish(new Error("Worker handshake timed out")),options.timeouts.handshakeTimeoutMs);
          child.on("message",message);child.once("error",failed);child.once("exit",failedExit);
        });
        const expected = spec.role === "All" ? AGENT_CORE_NODES : CAPABILITIES[spec.role];
        if (u.ready.pid!==child.pid || u.ready.address.workerId!==spec.id || JSON.stringify(expected)!==JSON.stringify(u.ready.capabilities)) throw new Error("Worker handshake identity mismatch");
      } catch (error) { startupError ??= error; }
    }
  }
  try {
    const parallel = options.startupConcurrency ?? 4;
    if(!Number.isSafeInteger(parallel)||parallel<1||parallel>32)throw new Error("Invalid startup concurrency");
    await Promise.all(Array.from({length:Math.min(parallel,specs.length)},startNext));
    if(startupError||stopped) throw startupError??new Error(stopped);
    const wrappers: InvokeTransport[] = units.map(u => {
      const ipc = makeTransport({id:u.id,channel:u.child,timeoutMs:options.timeouts.ipcTimeoutMs});transports.push(ipc);
      return {id:u.id,async invoke(envelope) {
        const payload:any=envelope.payload;
        const row:any={invocationId:envelope.id,node:envelope.node,workerId:u.id,pid:u.child.pid,execution:envelope.execution??null,
          taskId:taskFrom(payload.value),attempted:stamp(),sent:null,returned:null};
        try { if(stopped)throw new Error(stopped);row.sent=stamp();
          return await captureScoring(envelope.node,payload.value,{invocationId:envelope.id,workerId:u.id,nodePid:u.child.pid},
            async()=>{
              let origin:FailureType|undefined;
              const expectedTool = toolInvocationIdentity(envelope);
              let toolFailure:Error|undefined, toolReports=0;
              // Keep the raw invocation boundary available to the existing crash probes.
              const invoke=()=>ipc.invoke(envelope);
              const message=(m:any)=>{
                if(m?.protocol!=="bfcl:manage:1"||m.kind!=="failure-origin"||m.id!==envelope.id||
                  m.workerId!==u.id||m.pid!==u.child.pid||!isFailureType(m.failureType))return;
                origin??=m.failureType;
                if (m.failureType !== "tool-channel" || !expectedTool) return;
                toolReports++;
                if (toolReports !== 1 || !Object.entries(expectedTool).every(([key, value])=>m.toolInvocation?.[key] === value)) {
                  toolFailure = undefined;
                  return;
                }
                toolFailure = restoreToolFailure(m.toolFailure, expectedTool.toolName);
              };
              u.child.on("message",message);
              try{return await invoke();}
              catch(error){
                const restored = error instanceof Error && error.message === "Worker invocation failed" ? toolFailure : undefined;
                const failure = restored ?? error;
                throw origin ? markFailure(failure,origin,expectedTool && origin==="tool-channel"
                  ? {node:envelope.node,workerId:u.id} : null) : failure;
              }
              finally{u.child.off("message",message);}
            },reply=>{
              if(payload.kind!=="inline"||reply.payload.kind!=="inline"||reply.invocationId!==envelope.id)throw new Error("Required scoring IPC payload unavailable");
              return reply.payload.value;
            });
        }
        catch(error){row.error=errorText(error);throw error;}
        finally{row.returned=stamp();log(join(options.directory,"parent.steps.jsonl"),row);}
      }};
    });
    runtime=createDitto({config:loadRuntimeConfig({}),transports:wrappers});
    // T11：留住登记句柄，问模型／整理工具结果每次派给排队最少的那一份（least-queued.ts）。
    useLeastQueued(runtime,new Map(units.map(u=>[u.id,runtime!.registerRemote({address:u.ready.address as WorkerAddress,capabilities:u.ready.capabilities,transportId:u.id})])));
    startupEnded=stamp();
  } catch(error) { startupEnded=stamp();await close();throw error; }
  const handles=new Map<string,AgentCoreInstanceHandle>();
  for(const u of units) handles.set(u.id,{instanceId:u.id,releaseTask(taskId){
    if(u.dead||!u.child.connected)return Promise.reject(new Error(`Worker 退出：${u.id} cleanup unavailable`));
    return new Promise((resolve,reject)=>{
      const id=randomUUID();
      const finish=(error?:unknown,result?:any)=>{clearTimeout(timer);u.child.off("message",message);u.child.off("disconnect",disconnect);error?reject(error):resolve(result);};
      const message=(m:any)=>{if(m?.protocol==="bfcl:manage:1"&&m.kind==="released"&&m.id===id)finish('error' in m?cleanupReplyError(m.error,m.aggregateError,
        {workerId:u.id,sources:Array.isArray(m.cleanupSources)?m.cleanupSources.filter((source:any)=>["context","python","memory","model-drain"].includes(source)):[]}):undefined,m.result);};
      const disconnect=()=>finish(new Error(`Worker 退出：${u.id} during cleanup`));
      const timer=setTimeout(()=>finish(new Error("Cleanup timed out")),options.timeouts.cleanupTimeoutMs);
      u.child.on("message",message);u.child.once("disconnect",disconnect);
      u.child.send({protocol:"bfcl:manage:1",kind:"release",id,taskId},error=>{if(error)finish(error);});
    });
  }});
  const owners=new Map<string,string[]>();
  async function confirmAlive(workerIds:Iterable<string>) {
    return Promise.all([...new Set(workerIds)].map(async workerId => {
      const u=units.find(unit=>unit.id===workerId),started=stamp(),id=randomUUID();
      const base={workerId,pid:u?.child.pid??null,id,started};
      if(!u)return {...base,alive:false,method:"missing-worker",confirmedAt:stamp()};
      return new Promise<any>(resolve=>{
        const child=u.child;let settled=false;
        const finish=(alive:boolean,method:string,error?:unknown,workerAt?:unknown)=>{
          if(settled)return;settled=true;clearTimeout(timer);
          child.off("message",message);child.off("disconnect",disconnect);child.off("exit",exited);child.off("error",failed);
          resolve({...base,alive,method,confirmedAt:stamp(),workerAt:workerAt??null,error:error===undefined?null:errorText(error)});
        };
        const disconnected=()=>u.dead||!child.connected||child.exitCode!==null||child.signalCode!==null;
        const message=(m:any)=>{
          if(m?.protocol!=="bfcl:manage:1"||m.kind!=="pong"||m.id!==id)return;
          if(m.workerId!==workerId||m.pid!==child.pid)finish(false,"invalid-pong");
          else if(disconnected())finish(false,"process-state");
          else finish(true,"pong",undefined,m.at);
        };
        const disconnect=()=>finish(false,"disconnect"),exited=()=>finish(false,"exit");
        const failed=(error:Error)=>finish(false,"error",error);
        const timer=setTimeout(()=>finish(false,"timeout"),options.timeouts.handshakeTimeoutMs);
        child.on("message",message);child.once("disconnect",disconnect);child.once("exit",exited);child.once("error",failed);
        if(disconnected()){finish(false,"process-state");return;}
        try{child.send({protocol:"bfcl:manage:1",kind:"ping",id},error=>{if(error)finish(false,"send-error",error);});}
        catch(error){finish(false,"send-error",error);}
      });
    }));
  }
  return {runtime:runtime!,handles,units,stop,close,workerRecordingFailures,confirmAlive,get stopped(){return stopped;},attach(taskId:string){
    if(stopped||owners.has(taskId))throw new Error(stopped??"Duplicate task ID");
    const choose=(role:string)=>{
      const candidates=units.filter(u=>u.role===role).sort((a,b)=>a.assigned-b.assigned||Number(a.id.split("-").at(-1))-Number(b.id.split("-").at(-1)));
      return candidates[0].id;
    };
    const assignment:Assignment=options.group==="Monolithic"?{worker:choose("All")}:{context:choose("Context"),interaction:choose("Interaction"),memory:choose("Memory")};
    const bindings=createBindings(options.group,assignment);verifyBindings(options.group,assignment,bindings,runtime!.workers());
    for(const id of Object.values(assignment))units.find(u=>u.id===id)!.assigned++;
    owners.set(taskId,Object.values(assignment));return {assignment,bindings};
  },detach(taskId:string){for(const id of owners.get(taskId)??[])units.find(u=>u.id===id)!.assigned--;owners.delete(taskId);}};
}
