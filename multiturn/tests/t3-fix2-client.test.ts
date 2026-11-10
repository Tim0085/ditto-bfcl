import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCoreWorker } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { createModelClient } from "../src/ts/model-client.ts";
import { fakeServer } from "./t7-helpers.ts";
import { context, options, input, output } from "./t3-helpers.ts";

for (const fault of ["refused", "reset", "non-json", "missing-output", "missing-message", "missing-finish", "coerced-finish", "bad-action", "missing-error-message"]) {
  test(`M2 SAMPLE Worker/Direct: ${fault}`, async () => {
    const server = await fakeServer((_body, res) => {
      if (fault === "reset") { res.writeHead(200, {"content-length": "10000"}); res.write('{"ok":'); setImmediate(() => res.destroy()); }
      else if (fault === "non-json") res.end("not json");
      else res.end(JSON.stringify(fault === "missing-output" ? {ok:true} :
        fault === "missing-message" ? {ok:true, output:{finishReason:"stop"}} :
        fault === "missing-finish" ? {ok:true, output:{message:output.message}} :
        fault === "coerced-finish" ? {ok:true, output:{...output,finishReason:["stop"]}} :
        fault === "missing-error-message" ? {ok:false,error:{kind:"input_limit",details:{inputBytes:2,maxRequestBytes:1}}} :
        {ok:true, output:{...output, actionRequests:[{id:"a",name:"x",arguments:{}}]}}));
    });
    if (fault === "refused") await server.close();
    const o = await options({modelEndpoint:server.url, providerFactory:undefined, inferenceTimeoutMs:5000});
    const worker = createAgentCoreWorker(o).instantiate(), direct = createDirectSteps(o);
    try {
      for (const [mode, result] of [["Worker", await worker.execute("INFER.REASONING.SAMPLE",input,context())], ["Direct", await direct.execute("INFER.REASONING.SAMPLE",input)]] as any[]) {
        assert.equal(result.status,"failed"); assert.match(result.error.message,/^BFCL_RUN_STOP:/);
        if(fault === "refused") assert.match(result.error.message,/ECONNREFUSED/);
        if(fault === "reset") assert.match(result.error.message,/aborted|reset|hang up/i);
        if(fault === "non-json") assert.match(result.error.message,/JSON/);
        console.log(JSON.stringify({fault,mode,result}));
      }
    } finally { await worker.dispose?.(); await direct.dispose(); if(fault !== "refused") await server.close(); }
  });
}

test("M2 active and pre-aborted cancellation retain the exact reason, without run-stop", async () => {
  let received!:()=>void;
  const arrival = new Promise<void>(r=>received=r);
  const server = await fakeServer(()=>received());
  try {
    for(const pre of [false,true]) {
      const abort = new AbortController(), reason = new Error("intentional abort");
      if(pre) abort.abort(reason);
      const pending = createModelClient(server.url).invoke(input,{signal:abort.signal});
      if(!pre) { await arrival; abort.abort(reason); }
      await assert.rejects(pending,e=>e===reason && !String(e).includes("BFCL_RUN_STOP:"));
    }
  } finally { await server.close(); }
});

test("M2 valid business errors and normal outputs are unchanged", async () => {
  const replies:any[] = [
    ...["run_stop","input_limit","request_limit"].flatMap(kind=>[
      {ok:false,error:{kind,message:"original",details:{reason:"business"}}},
      {ok:false,error:{kind,message:"original"}}]),
    ...["stop","length","cancelled","error"].map(finishReason=>({ok:true,output:{...output,finishReason}}))
  ];
  let next=0;
  const server=await fakeServer((_body,res)=>res.end(JSON.stringify(replies[next++])));
  try {
    for(const reply of replies) {
      const pending=createModelClient(server.url).invoke(input,{signal:new AbortController().signal});
      if(reply.ok) assert.deepEqual(await pending,reply.output);
      else {
        const prefix=({run_stop:"BFCL_RUN_STOP:",input_limit:"BFCL_INPUT_LIMIT:",request_limit:"BFCL_PHYSICAL_REQUEST_LIMIT:"} as any)[reply.error.kind];
        await assert.rejects(pending,{message:prefix+JSON.stringify(reply.error.details??{message:reply.error.message})});
      }
    }
  } finally { await server.close(); }
});
