import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const guards={
  '/runtime/runtime.js':['constructor(options = {}) {'],
  '/runtime/router.js':['select(node, entries, hostId, workerId) {'],
  '/runtime/graph.js':['constructor(id, tasks) {','export function graph(id = "agent") {','export async function runGraph(graph, input, invoke, options = {}) {'],
  '/runtime/communication/ipc.js':['export function createIpcTransport({ id, channel, timeoutMs = 30_000 }) {','export function serveWorkerIpc(runtime, channel) {'],
};
globalThis.__t4Forbidden=[];const installed=[];
registerHooks({load(url,ctx,next){const result=next(url,ctx);if(!url.includes('/vendor/ditto/dist/'))return result;
  for(const [suffix,needles]of Object.entries(guards))if(url.endsWith(suffix)) {
    let source=String(result.source);for(const needle of needles){assert(source.includes(needle));source=source.replace(needle,needle+`globalThis.__t4Forbidden.push(${JSON.stringify(needle)});throw new Error('T4 forbidden dispatch');`);installed.push(needle);}return {...result,source};
  }return result;
}});
const {egress,temporary,python,taskOptions,legacy,selectedCases}=await import('./t4-helpers.ts');
const {createDirectSteps}=await import('../src/ts/direct-steps.ts');
const {runDirectTask}=await import('../src/ts/direct-task.ts');
const {loadTask,MULTI_TURN_CATEGORIES}=await import('../src/ts/tool-actions.ts');
const root=process.argv[2]??await temporary();await mkdir(root,{recursive:true});const out=await mkdtemp(join(root,'direct-proof-'));
const gateway=await egress('replay',join(out,'egress'));
const steps=createDirectSteps({python,memoryDirectory:join(out,'memory'),inferenceTimeoutMs:30000,modelEndpoint:gateway.url});
let cases=0,requests=0;
try {
  const selection=selectedCases('replay',Number(process.argv[3]??1));
  await writeFile(join(out,'selection.json'),JSON.stringify(selection,null,2));
  for(const caseId of selection) {
    const result=await runDirectTask(steps,await loadTask(caseId),taskOptions(`proof/Direct/r1/${caseId}`));
    const old=await legacy(caseId);for(const key of ['completed','completedTurns','executionOutcome','termination'])assert.deepEqual(result[key],old[key]);
    cases++;requests+=result.usage.requests;
  }
}finally{await steps.dispose();await gateway.close();}
assert.equal(installed.length,7);assert.deepEqual(globalThis.__t4Forbidden,[]);
const summary={cases,requests,installedGuards:installed.length,runtimeConstructions:0,graphConstructions:0,graphRuns:0,routingCalls:0,dittoIpcCalls:0,output:out};
await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
const runtime=await import('../vendor/ditto/dist/runtime/runtime.js'),{WorkerRouter}=await import('../vendor/ditto/dist/runtime/router.js'),graph=await import('../vendor/ditto/dist/runtime/graph.js'),ipc=await import('../vendor/ditto/dist/runtime/communication/ipc.js');
for(const call of [()=>runtime.createDitto(),()=>new WorkerRouter().select(),()=>graph.graph(),()=>ipc.createIpcTransport({}),()=>ipc.serveWorkerIpc()])assert.throws(call,/T4 forbidden dispatch/);
assert.equal(globalThis.__t4Forbidden.length,5);console.log('Positive controls: Runtime, routing, Graph, IPC client and IPC server all rejected. Vendor unchanged.');
