import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join,resolve } from "node:path";
import { mkdir,readFile } from "node:fs/promises";
const targets:Record<string,string[]>={
  "/runtime/runtime.js":["constructor(options = {}) {"],
  "/runtime/router.js":["select(node, entries, hostId, workerId) {"],
  "/runtime/graph.js":["constructor(id, tasks) {","export function graph(id = \"agent\") {","export async function runGraph(graph, input, invoke, options = {}) {"],
  "/runtime/communication/ipc.js":["export function createIpcTransport({ id, channel, timeoutMs = 30_000 }) {","export function serveWorkerIpc(runtime, channel) {"],
};
let installed=0; (globalThis as any).__t7DispatchCalls=0;
registerHooks({load(url,ctx,next){const r=next(url,ctx);if(!url.includes("/vendor/ditto/dist/"))return r;
  for(const [suffix,needles]of Object.entries(targets))if(url.endsWith(suffix)){
    let source=String(r.source);for(const needle of needles){assert(source.includes(needle));source=source.replace(needle,needle+"globalThis.__t7DispatchCalls++;throw new Error('T7 forbidden dispatch');");installed++;}return {...r,source};
  }return r;
}});
const {block,fakeServer,sampleOutput}=await import("./t7-helpers.ts");
const {runBlock}=await import("../src/ts/config-main.ts");
const {childEnvironment}=await import("../src/ts/deploy.ts");
const env=childEnvironment();for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
const directory=resolve(process.argv[2]);await mkdir(directory,{recursive:true});
const server=await fakeServer((_body,res)=>setTimeout(()=>res.end(JSON.stringify({ok:true,output:sampleOutput})),100));
try{
  const b=await block(directory,server.url,"Direct","proof",8,Array.from({length:8},(_,i)=>`multi_turn_base_${i}`));
  const result=await runBlock(b);assert.equal(result.exitCode,0);assert.equal(result.maxActive,8);assert.equal(installed,7);assert.equal((globalThis as any).__t7DispatchCalls,0);
  const life=JSON.parse(await readFile(join(directory,"configs/proof/lifecycle.json"),"utf8"));assert.equal(life.processes.length,0);
  console.log(JSON.stringify({tasks:result.completed,maxActive:result.maxActive,installedGuards:installed,dispatchCalls:0,workerChildren:0}));
  const rt=await import("../vendor/ditto/dist/runtime/runtime.js"),router=await import("../vendor/ditto/dist/runtime/router.js"),g=await import("../vendor/ditto/dist/runtime/graph.js"),ipc=await import("../vendor/ditto/dist/runtime/communication/ipc.js");
  for(const call of [()=>rt.createDitto(),()=>(new router.WorkerRouter().select as any)(),()=>g.graph(),()=>ipc.createIpcTransport({} as any),()=>ipc.serveWorkerIpc({} as any,{} as any)])assert.throws(call,/T7 forbidden dispatch/);
  console.log("PASS: Direct config-main has 8 active tasks, no Runtime/Graph/router/IPC; all five positive controls rejected");
}finally{await server.close();}
