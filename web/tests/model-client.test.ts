import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createModelClient } from "../src/ts/model-client.ts";
import { MODEL_ENDPOINT_PROTOCOL, MODEL_ENDPOINT_PATH } from "../src/ts/model-endpoint.ts";
import { inputLimitDetails, requestLimitDetails } from "./t3-legacy-retry.ts";
import { input, output } from "./t3-helpers.ts";
async function server(t:TestContext, handler:(req:IncomingMessage,res:ServerResponse,body:any)=>void) {
  const errors:unknown[]=[];
  const http=createServer(async(req,res)=>{
    try {const chunks:Buffer[]=[];for await(const chunk of req) chunks.push(chunk); handler(req,res,JSON.parse(Buffer.concat(chunks).toString("utf8")));}
    catch(e){errors.push(e);res.writeHead(500).end('{}');}
  });
  http.listen(0,"127.0.0.1");await once(http,"listening");
  t.after(async()=>{http.closeAllConnections();await new Promise<void>((resolve,reject)=>http.close(e=>e?reject(e):resolve()));assert.deepEqual(errors,[]);});
  return `http://127.0.0.1:${(http.address() as {port:number}).port}`;
}
test("model client sends exact protocol and identity from metadata; missing/invalid identities never sent",async t=>{
  let requests=0;
  const endpoint=await server(t,(req,res,body)=>{
    requests++;assert.equal(req.url,MODEL_ENDPOINT_PATH);assert.equal(req.method,"POST");
    assert.deepEqual(body,{protocol:MODEL_ENDPOINT_PROTOCOL,...input.metadata,input});
    res.end(JSON.stringify({ok:true,output}));
  });
  const provider=createModelClient(endpoint),signal=AbortSignal.timeout(5000);
  assert.deepEqual(await provider.invoke(input,{signal}),output);
  for(const key of ["configId","taskId","caseId","turn","step"]) {
    const metadata={...input.metadata};delete metadata[key];
    await assert.rejects(provider.invoke({...input,metadata},{signal}),new RegExp(key));
  }
  for(const metadata of [{...input.metadata,turn:0},{...input.metadata,step:1.2},{...input.metadata,taskId:" "}]) await assert.rejects(provider.invoke({...input,metadata},{signal}));
  assert.equal(requests,1);
});
test("model client errors round-trip through verbatim legacy retry parsers",async t=>{
  const cases=[
    {kind:"input_limit",details:{inputBytes:8388609,maxRequestBytes:8388608}},
    {kind:"request_limit",details:{physicalModelRequests:3,budgetWaitMs:7,failedModelAttempts:[{id:"attempt",reason:"transport_unknown",heldReferenceMicroUsd:10}]}},
    {kind:"run_stop",details:{reason:"test budget stop"}},
  ];
  let index=0;
  const endpoint=await server(t,(_req,res)=>res.end(JSON.stringify({ok:false,error:{...cases[index++],message:"test"}})));
  const p=createModelClient(endpoint);
  for(const value of cases) await assert.rejects(p.invoke(input,{signal:AbortSignal.timeout(5000)}),(error:any)=>{
    if(value.kind==="input_limit") assert.deepEqual(inputLimitDetails(error),value.details);
    else if(value.kind==="request_limit") assert.deepEqual(requestLimitDetails(error),value.details);
    else assert.equal(error.message,"BFCL_RUN_STOP:"+JSON.stringify(value.details));
    return true;
  });
  const old=(await readFile("../../bfcl_direct/src/ts/retry.ts","utf8")).replaceAll("\r\n","\n");
  const copy=(await readFile("tests/t3-legacy-retry.ts","utf8")).replaceAll("\r\n","\n");
  for(const name of ["inputLimitDetails","requestLimitDetails"]) {
    const extract=(s:string)=>{const start=s.indexOf(`export function ${name}`);return s.slice(start,s.indexOf("\n}",start)+2);};
    assert.equal(extract(copy),extract(old));
  }
  console.log("input_limit/request_limit decoded by unchanged old functions; run_stop prefix exact");
});
test("model client cancellation interrupts an in-flight HTTP request",async t=>{
  let received!:()=>void,closed!:()=>void;
  const arrival=new Promise<void>(r=>received=r),closure=new Promise<void>(r=>closed=r);
  const endpoint=await server(t,(_req,res)=>{res.once("close",closed);received();});
  const controller=new AbortController();
  const task=createModelClient(endpoint).invoke(input,{signal:controller.signal});
  await arrival;controller.abort(new Error("abort in-flight"));
  await assert.rejects(task,/abort in-flight/);
  await Promise.race([closure,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error("socket did not close")),3000);timer.unref();})]);
});
test("model client: 81 simultaneous requests reach server before ANY response",async t=>{
  const pending:{res:ServerResponse;body:any}[]=[];
  const endpoint=await server(t,(_req,res,body)=>{
    pending.push({res,body});
    if(pending.length===81) for(const x of pending) x.res.end(JSON.stringify({ok:true,output:{...output,message:{role:"assistant",content:x.body.taskId}}}));
  });
  const p=createModelClient(endpoint),signal=AbortSignal.timeout(10000);
  const results=await Promise.all(Array.from({length:81},(_,i)=>p.invoke({...input,metadata:{...input.metadata,taskId:`task-${i}`}},{signal})));
  assert.equal(pending.length,81);
  assert.deepEqual(results.map(x=>x.message.content),Array.from({length:81},(_,i)=>`task-${i}`));
  console.log(JSON.stringify({receivedBeforeFirstResponse:pending.length,completed:results.length,identityMatches:81}));
});
