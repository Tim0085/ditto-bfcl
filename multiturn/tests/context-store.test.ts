import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryContextStore, createContextWorker, createContextOperationQueue } from "@codesoul-co/ditto/worker/context";
import { createContextStore } from "../src/ts/context-store.ts";
import { createAgentCoreWorker, CONTEXT_POLICY } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { context, options, outcome } from "./t3-helpers.ts";

test("Context store: official CAS/conflict/freeze/TTL/LRU/cancellation parity and delete",async()=>{
  let now=0;
  const stores=[createContextStore({ttlMs:100,maxEntries:2,now:()=>now}),createInMemoryContextStore({ttlMs:100,maxEntries:2,now:()=>now})];
  async function sequence(store: typeof stores[number]) {
    now=0; const a={sessionId:"task-a"},b={sessionId:"task-b"},c={sessionId:"task-c"};
    const seen: unknown[]=[];
    const summarize=(v:any)=>v===undefined?undefined:{context:v.context,versionType:typeof v.version};
    seen.push(await store.get(a));
    const supplied={items:[{id:"one",content:"one"}]};
    const first=await store.compareAndSet(a,undefined,supplied);
    supplied.items[0].content="mutated outside";
    assert.equal(first.context.items[0].content,"one");assert.ok(Object.isFrozen(first.context.items[0]));
    seen.push(summarize(first),summarize(await store.get(a)));
    seen.push(await outcome(()=>store.compareAndSet(a,"wrong",{items:[]})));
    const second=await store.compareAndSet(a,first.version,{items:[{id:"two",content:"next"}]});
    assert.notEqual(first.version,second.version);seen.push(summarize(second));
    await store.compareAndSet(b,undefined,{items:[]}); await store.get(a);
    await store.compareAndSet(c,undefined,{items:[]});
    seen.push(summarize(await store.get(a)),await store.get(b),summarize(await store.get(c)));
    now=101;seen.push(await store.get(a));
    seen.push(await outcome(()=>store.compareAndSet(a,second.version,{items:[]})));
    const controller=new AbortController(); controller.abort(new Error("cancelled by test"));
    seen.push(await outcome(()=>store.get(c,{signal:controller.signal})));
    seen.push(await outcome(()=>store.compareAndSet(c,undefined,{items:[]},{signal:controller.signal})));
    seen.push(await outcome(()=>store.get({sessionId:""})));
    return seen;
  }
  assert.deepEqual(await sequence(stores[0]),await sequence(stores[1]));
  const own=stores[0] as ReturnType<typeof createContextStore>,scope={sessionId:"delete"};
  await own.compareAndSet(scope,undefined,{items:[]}); assert.equal(await own.delete(scope),true);
  assert.equal(await own.get(scope),undefined);assert.equal(await own.delete(scope),false);
  const controller=new AbortController();controller.abort(new Error("delete aborted"));
  await assert.rejects(own.delete(scope,{signal:controller.signal}),/delete aborted/);
  console.log("CAS/get/error parity: versions mapped per store; frozen copies, TTL, LRU, delete and abort verified");
});

test("Context: 300 items with 100 KiB item LOAD/UPDATE/SELECT under task scope",async()=>{
  const worker=createAgentCoreWorker(await options()).instantiate();
  const scope={sessionId:"long-task"};
  const items=Array.from({length:300},(_,i)=>({id:String(i),content:i===123?"x".repeat(100*1024):`message ${i}`}));
  try {
    const loaded:any=await worker.execute("CONTEXT.LOAD",{scope,sources:items},context());assert.equal(loaded.items.length,300);
    const updated:any=await worker.execute("CONTEXT.UPDATE",{scope,add:[{id:"123",content:"y".repeat(100*1024)}]},context());
    assert.equal(updated.items.length,300);assert.equal(updated.items[123].content.length,100*1024);
    const selected:any=await worker.execute("CONTEXT.SELECT",{scope,purpose:"infer"},context());
    assert.equal(selected.context.items.length,300);assert.equal(new Set(selected.selectedItemIds).size,300);
    assert.deepEqual([...selected.selectedItemIds].sort(),items.map(x=>x.id).sort());
    assert.deepEqual(await worker.execute("CONTEXT.LOAD",{scope},context()),updated);
    console.log(JSON.stringify({maxItems:CONTEXT_POLICY.maxItems,maxInlineBytes:CONTEXT_POLICY.maxInlineBytes,load:300,update:300,select:300,largeContentBytes:100*1024}));
  } finally {await worker.dispose?.();}
});

test("Context: exactly 1000000 serialized UTF-8 bytes accepted, 1000001 rejected exactly like official",async()=>{
  const worker=createAgentCoreWorker(await options()).instantiate();
  const official=createContextWorker({policy:CONTEXT_POLICY,services:{stateStore:createInMemoryContextStore(),operationQueue:createContextOperationQueue()}}).instantiate();
  const direct=createDirectSteps(await options());
  try {
    for(const bytes of [1_000_000,1_000_001]) {
      const content="汉".repeat(333_332)+"a".repeat(bytes-999_996-2);
      assert.equal(Buffer.byteLength(JSON.stringify(content)),bytes);
      const request={scope:{sessionId:`boundary-${bytes}`},sources:[{id:"edge",content}]};
      const a:any=await outcome(()=>worker.execute("CONTEXT.LOAD",request,context()));
      assert.deepEqual(a,await outcome(()=>official.execute("CONTEXT.LOAD",request,context())) as any);
      assert.deepEqual(a,await outcome(()=>direct.execute("CONTEXT.LOAD",request)) as any);
      if(bytes===1_000_000) {
        assert.equal(a.items.length,1);assert.equal(a.items[0].content,content);
        const update={scope:request.scope,add:[{id:"edge",content}]};
        assert.deepEqual(await worker.execute("CONTEXT.UPDATE",update,context()),await official.execute("CONTEXT.UPDATE",update,context()));
      } else {
        assert.equal(a.thrown.code,"INLINE_LIMIT_EXCEEDED");
        const update={scope:{sessionId:"boundary-1000000"},add:[{id:"edge",content}]};
        assert.deepEqual(await outcome(()=>worker.execute("CONTEXT.UPDATE",update,context())),await outcome(()=>official.execute("CONTEXT.UPDATE",update,context())));
      }
      console.log(JSON.stringify({serializedUtf8Bytes:bytes,result:bytes===1_000_000?"accepted":a.thrown}));
    }
    assert.equal(await direct.deleteContext("boundary-1000000"),true);
    await assert.rejects(direct.execute("CONTEXT.LOAD",{scope:{sessionId:"boundary-1000000"}}),/absent or expired/);
  } finally {await worker.dispose?.();await official.dispose?.();await direct.dispose();}
});
