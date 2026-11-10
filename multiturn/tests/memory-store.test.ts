import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { createMemoryStore } from "../src/ts/memory-store.ts";
import { createAgentCoreWorker } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { context, options, normalize, input } from "./t3-helpers.ts";

test("Memory via agent-core: nonempty WRITE/GET/QUERY/UPDATE/DELETE, SEARCH parity; two files persist after restart",async()=>{
  const o=await options(), worker=createAgentCoreWorker(o).instantiate();
  const official=createMemoryWorker({store:createMemoryStore(o.memoryDirectory)}).instantiate();
  const call=async(node:any,value:unknown)=>await worker.execute(node,value,context()) as any;
  const drafts=["run/config/task-a","run/config/task-b"].map(taskId=>({key:taskId+"/turn-1",content:{messages:input.messages,completedTurns:1},metadata:{taskId,turn:1}}));
  try {
    const written=await call("MEMORY.WRITE",{memories:drafts});assert.equal(written.status,"success");assert.equal(written.output.length,2);
    const [a,b]=written.output;
    assert.notEqual(a.id,b.id);
    const names=await readdir(o.memoryDirectory);assert.equal(names.length,2);
    const files=await Promise.all(names.map(n=>readFile(join(o.memoryDirectory,n),"utf8").then(JSON.parse)));
    assert.deepEqual(files.map(x=>x.taskId).sort(),drafts.map(x=>x.metadata.taskId).sort());
    for(const file of files) {assert.equal(file.memories.length,1);assert.equal(file.memories[0].metadata.taskId,file.taskId);assert.deepEqual(file.memories[0].content,drafts[0].content);}
    for(const request of [{keys:[a.key]},{ids:[a.id,b.id]},{keys:[a.key],ids:[a.id,b.id]}]) {
      const got=await call("MEMORY.GET",request);assert.equal(got.status,"success");
      assert.deepEqual(normalize(got),normalize(await official.execute("MEMORY.GET",request,context())));
    }
    const queried=await call("MEMORY.QUERY",{filter:{"metadata.taskId":drafts[0].metadata.taskId}});
    assert.equal(queried.output.items.length,1);assert.equal(queried.output.items[0].id,a.id);
    const search={query:"hello"};
    const failed=await call("MEMORY.SEARCH",search);assert.equal(failed.status,"failed");
    assert.deepEqual(normalize(failed),normalize(await official.execute("MEMORY.SEARCH",search,context())));
    const changed={messages:[...input.messages,{role:"assistant",content:"done"}],completedTurns:2};
    const updated=await call("MEMORY.UPDATE",{memories:[{id:a.id,content:changed,metadata:{taskId:drafts[0].metadata.taskId,turn:2}}]});
    assert.equal(updated.status,"success");assert.deepEqual(updated.output[0],{id:a.id,key:a.key,content:changed,metadata:{taskId:drafts[0].metadata.taskId,turn:2}});
    const reopened=createDirectSteps(o);
    try {const saved:any=await reopened.execute("MEMORY.GET",{ids:[a.id]});assert.deepEqual(saved.output,updated.output);}finally{await reopened.dispose();}
    const deleted=await call("MEMORY.DELETE",{ids:[a.id,a.id]});assert.equal(deleted.status,"success");assert.deepEqual(deleted.output,{deleted:[a.id]});
    assert.deepEqual((await call("MEMORY.DELETE",{ids:[a.id]})).output,{deleted:[]});
    assert.deepEqual((await call("MEMORY.DELETE",{ids:["never-existed",a.id]})).output,{deleted:[]});
    assert.deepEqual((await call("MEMORY.GET",{ids:["never-existed"],keys:["missing-key"]})).output,[]);
    assert.deepEqual((await call("MEMORY.GET",{ids:[a.id,b.id]})).output,[b]);
    assert.equal((await call("MEMORY.UPDATE",{memories:[{id:a.id,content:"missing"}]})).status,"failed");
    console.log(JSON.stringify({files:2,recordsWritten:2,updated:1,deleted:1,reopened:true,search:failed.error.code}));
  } finally {await worker.dispose?.();await official.dispose?.();}
});

test("Memory store: same-task concurrent writes, stable pagination/order/filter, failed write leaves existing record unchanged",async()=>{
  const o=await options(), store=createMemoryStore(o.memoryDirectory);
  const items=await Promise.all(Array.from({length:12},(_,i)=>store.write({memories:[{key:`task/turn-${i}`,content:{turn:i},metadata:{n:i}}]})));
  assert.equal((await store.query({})).items.length,12);
  const first=await store.query({limit:5,orderBy:[{field:"metadata.n",direction:"desc"}]});
  const second=await store.query({limit:5,cursor:first.nextCursor,orderBy:[{field:"metadata.n",direction:"desc"}]});
  assert.deepEqual(first.items.map(x=>x.metadata!.n),[11,10,9,8,7]);assert.deepEqual(second.items.map(x=>x.metadata!.n),[6,5,4,3,2]);
  const a=items[0][0];
  await store.update({memories:[{id:a.id,metadata:{replaced:true}}]});assert.deepEqual((await store.get({ids:[a.id]}))[0].metadata,{replaced:true});
  await assert.rejects(store.write({memories:[{key:"task/bad",content:{lost:undefined}}]}),/JSON/);
  assert.equal((await store.query({})).items.length,12);
  await assert.rejects(store.write({memories:[{key:a.key,content:"duplicate"}]}),/已存在/);
  const ctrl=new AbortController();ctrl.abort(new Error("cancelled"));
  await assert.rejects(store.write({memories:[{key:"task/cancelled",content:"x"}]},{signal:ctrl.signal}),/cancelled/);
  assert.equal((await store.query({})).items.length,12);
});
