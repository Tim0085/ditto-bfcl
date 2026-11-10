import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCoreWorker, type AgentCoreInstanceHandle } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { options, context } from "./t3-helpers.ts";
import { BFCL_CONTEXT_TTL_MS, createContextStore } from "../src/ts/context-store.ts";

test("M1 one-year TTL bounds, expiry and worst eight-batch node wait", async () => {
  assert(BFCL_CONTEXT_TTL_MS > 8 * (2 ** 31 - 1));
  for(const ttlMs of [0,-1,NaN,Infinity,1.5,BFCL_CONTEXT_TTL_MS+1]) assert.throws(()=>createContextStore({ttlMs}),/Invalid Context ttlMs/);
  let now=0;
  const scope={sessionId:"year"}, store=createContextStore({ttlMs:BFCL_CONTEXT_TTL_MS,now:()=>now});
  await store.compareAndSet(scope,undefined,{items:[]});
  now=BFCL_CONTEXT_TTL_MS-1;assert(await store.get(scope));
  now=BFCL_CONTEXT_TTL_MS;assert.equal(await store.get(scope),undefined);
  console.log(JSON.stringify({ttlMs:BFCL_CONTEXT_TTL_MS,maxEightBatchWaitMs:8*(2**31-1),expiryUnchanged:true}));
});

test("M1 unchanged item-count boundary: 10000 accepted, 10001 rejected", async () => {
  const o=await options(), worker=createAgentCoreWorker(o).instantiate(), direct=createDirectSteps(o);
  try {
    for(const mode of ["Worker","Direct"]) {
      const execute=(n:any,i:any):Promise<any>=>mode==="Worker"?worker.execute(n,i,context()):direct.execute(n,i);
      const scope={sessionId:mode+"-boundary"}, sources=Array.from({length:10000},(_,i)=>({id:String(i),content:"x"}));
      assert.equal((await execute("CONTEXT.LOAD",{scope,sources})).items.length,10000);
      await assert.rejects(execute("CONTEXT.UPDATE",{scope,add:[{id:"extra",content:"x"}]}),{code:"ITEM_LIMIT_EXCEEDED"});
      await assert.rejects(execute("CONTEXT.LOAD",{scope:{sessionId:mode+"-over"},sources:[...sources,{id:"extra",content:"x"}]}),{code:"ITEM_LIMIT_EXCEEDED"});
      assert.equal((await execute("CONTEXT.LOAD",{scope})).items.length,10000);
    }
  } finally {await worker.dispose?.();await direct.dispose();}
});

for (const mode of ["Worker", "Direct"]) for (const age of [61 * 60_000, 24 * 3_600_000, 7 * 24 * 3_600_000]) {
  test(`M1 ${mode}: idle ${age}ms LOAD/SELECT/UPDATE and releaseTask`, async t => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    let handle!: AgentCoreInstanceHandle;
    const o = await options({onInstance: h => handle = h});
    const worker = mode === "Worker" ? createAgentCoreWorker(o).instantiate() : undefined;
    const direct = mode === "Direct" ? createDirectSteps(o) : undefined;
    const execute = (n: any, i: any): Promise<any> => direct ? direct.execute(n, i) : worker!.execute(n, i, context());
    const scope = {sessionId: `idle-${mode}-${age}`};
    try {
      await execute("CONTEXT.LOAD", {scope, sources: [{id: "first", content: "unchanged"}]});
      now += age;
      assert.equal((await execute("CONTEXT.LOAD", {scope})).items[0].content, "unchanged");
      assert.equal((await execute("CONTEXT.SELECT", {scope, purpose: "infer"})).context.items[0].content, "unchanged");
      assert.equal((await execute("CONTEXT.UPDATE", {scope, add: [{id: "next", content: "after wait"}]})).items.length, 2);
      const released = await (direct ?? handle).releaseTask(scope.sessionId);
      assert.equal(released.contextDeleted, true);
      for (const [n, i] of [["CONTEXT.LOAD", {scope}], ["CONTEXT.SELECT", {scope, purpose: "infer"}], ["CONTEXT.UPDATE", {scope, add: [{id: "x", content: "x"}]}]]) {
        await assert.rejects(execute(n, i), {code: "CONTEXT_NOT_FOUND"});
      }
      console.log(JSON.stringify({mode, idleMs: age, load: true, select: true, update: true, release: "CONTEXT_NOT_FOUND"}));
    } finally { await worker?.dispose?.(); await direct?.dispose(); }
  });
}
