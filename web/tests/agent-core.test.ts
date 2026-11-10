import test from "node:test";
import assert from "node:assert/strict";
import { createDitto, createContextWorker, createInferWorker, createInteractionWorker, createMemoryWorker, loadRuntimeConfig } from "@codesoul-co/ditto";
import { createContextOperationQueue } from "@codesoul-co/ditto/worker/context";
import { createAgentCoreWorker, AGENT_CORE_NODES, CAPABILITIES, CONTEXT_POLICY, type AgentCoreNode } from "../src/ts/agent-core.ts";
import { createContextStore } from "../src/ts/context-store.ts";
import { createMemoryStore } from "../src/ts/memory-store.ts";
import { createToolService } from "../src/ts/tool-service.ts";
import { options,context,provider,outcome,valid,seedMemory } from "./t3-helpers.ts";
test("19 nodes and five actual registrations",async()=>{
  const definition=createAgentCoreWorker(await options());
  assert.equal(definition.type,"agent-core"); assert.equal(new Set(definition.capabilities).size,19);
  assert.deepEqual(definition.capabilities,AGENT_CORE_NODES);
  const runtime=createDitto({config:loadRuntimeConfig({}),transports:[{id:"offline",async invoke(){throw new Error("not used");}}]});
  try {
    runtime.register(definition,{id:"all"});
    for(const [group,nodes] of Object.entries(CAPABILITIES)) runtime.registerRemote({address:{workerId:group,workerType:definition.type,hostId:"other",processId:group},capabilities:nodes,transportId:"offline"});
    for(const worker of runtime.workers()) console.log(JSON.stringify({id:worker.address.workerId,capabilities:worker.capabilities}));
    assert.deepEqual(runtime.workers().map(w=>w.capabilities.length),[19,4,7,2,6]);
  } finally {await runtime.close();}
});
for(const node of AGENT_CORE_NODES.filter(n=>n!=="INFER.REASONING.SAMPLE")) test(`${node}: official valid + invalid input parity`,async()=>{
  const o=await options(), o2=await options(), actual=createAgentCoreWorker(o).instantiate();
  if(node.startsWith("MEMORY.")) {await seedMemory(o);await seedMemory(o2);}
  const tool=createToolService(o.python);
  const factory = node.startsWith("CONTEXT.")?createContextWorker({policy:CONTEXT_POLICY,services:{stateStore:createContextStore(),operationQueue:createContextOperationQueue()}}):
    node.startsWith("INFER.")?createInferWorker({providers:{configured:provider},defaultProvider:"configured",timeoutMs:1000}):
    node.startsWith("MEMORY.")?createMemoryWorker({store:createMemoryStore(o2.memoryDirectory)}):createInteractionWorker({tools:[tool.tool]});
  const official=factory.instantiate();
  try {
    for(const value of [valid[node],null]) {
      const result:any=await outcome(()=>actual.execute(node,value,context()));
      assert.deepEqual(result,await outcome(()=>official.execute(node,value,context())) as any);
      if(value===null) assert.ok(result.thrown || result.status==="failed");
      else if(!node.startsWith("CONTEXT.") && node!=="MEMORY.SEARCH") {
        assert.equal(result.status,"success");
        if(node==="MEMORY.UPDATE" || node==="MEMORY.GET") assert.equal(result.output.length,1);
        if(node==="MEMORY.DELETE") assert.equal(result.output.deleted.length,1);
      }
    }
  } finally {await actual.dispose?.();await official.dispose?.();await tool.dispose();}
});
for(const [group,nodes] of Object.entries(CAPABILITIES)) test(`${group}: only used service is created`,async()=>{
  const built:string[]=[], worker=createAgentCoreWorker(await options({onServiceCreated:name=>built.push(name)})).instantiate();
  assert.deepEqual(built,[]);
  try {await worker.execute(nodes[0],valid[nodes[0]],context()); assert.deepEqual(built,[group]); console.log(JSON.stringify({group,built}));}
  finally {await worker.dispose?.();}
});
