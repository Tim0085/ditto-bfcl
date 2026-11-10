// 本测试仅在自己的 Node 进程内插入拒绝钩子；不改任何 vendor 文件。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const guards = {
  '/runtime/runtime.js': ['constructor(options = {}) {'],
  '/runtime/router.js': ['select(node, entries, hostId, workerId) {'],
  '/runtime/graph.js': ['constructor(id, tasks) {','export function graph(id = "agent") {','export async function runGraph(graph, input, invoke, options = {}) {'],
  '/runtime/communication/ipc.js': ['export function createIpcTransport({ id, channel, timeoutMs = 30_000 }) {','export function serveWorkerIpc(runtime, channel) {'],
};
globalThis.__t3ForbiddenCalls=[];
const installed=[];
registerHooks({load(url,ctx,next){
  const result=next(url,ctx);
  if(!url.includes('/vendor/ditto/dist/')) return result;
  for(const [suffix,needles] of Object.entries(guards)) if(url.endsWith(suffix)) {
    let source=String(result.source);
    for(const needle of needles) {
      assert.ok(source.includes(needle),`Guard target not found: ${needle}`);
      source=source.replace(needle,needle+`globalThis.__t3ForbiddenCalls.push(${JSON.stringify(needle)});throw new Error("T3 forbidden dispatch");`);
      installed.push(needle);
    }
    return {...result,source};
  }
  return result;
}});
const {createDirectSteps}=await import('../src/ts/direct-steps.ts');
const {AGENT_CORE_NODES}=await import('../src/ts/agent-core.ts');
const {options,valid,seedMemory}=await import('./t3-helpers.ts');
for(const node of AGENT_CORE_NODES) {
  const o=await options();await seedMemory(o);const direct=createDirectSteps(o);
  try {const result=await direct.execute(node,valid[node]); if(!node.startsWith('CONTEXT.')&&node!=='MEMORY.SEARCH') assert.equal(result.status,'success');}
  finally {await direct.dispose();}
}
assert.equal(installed.length,7);assert.deepEqual(globalThis.__t3ForbiddenCalls,[]);
console.log(JSON.stringify({nodesExecuted:19,guardsInstalled:installed.length,runtimeConstructions:0,graphCalls:0,routingCalls:0,dittoIpcCalls:0}));
// 正控：同一个进程中，这些入口确实会被拒绝，不能因钩子未生效而假通过。
const runtime=await import('../vendor/ditto/dist/runtime/runtime.js');
const {WorkerRouter}=await import('../vendor/ditto/dist/runtime/router.js');
const graph=await import('../vendor/ditto/dist/runtime/graph.js');
const ipc=await import('../vendor/ditto/dist/runtime/communication/ipc.js');
for(const control of [()=>runtime.createDitto(),()=>new WorkerRouter().select(),()=>graph.graph(),()=>ipc.createIpcTransport({}),()=>ipc.serveWorkerIpc()]) assert.throws(control,/T3 forbidden dispatch/);
assert.equal(globalThis.__t3ForbiddenCalls.length,5);
console.log('Positive controls: all five forbidden entry points rejected; vendor files unchanged by in-memory hooks.');
