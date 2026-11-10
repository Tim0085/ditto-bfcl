import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInferWorker, type ModelProvider, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { createAgentCoreWorker } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { createBfclSampleExecutor } from "../src/ts/bfcl-sample.ts";
import { context, options, input, output, normalize } from "./t3-helpers.ts";
const node="INFER.REASONING.SAMPLE";
const call={id:"c",name:"unlisted",arguments:{value:1}};
const fixtures: [string,unknown,SampleOutput, string][] = [
  ["normal",input,output,"success"],
  ["length",input,{...output,finishReason:"length"},"success"],
  ["declared tool",{...input,actions:[{name:call.name,inputSchema:{type:"object"}}]},{...output,finishReason:"action_request",actionRequests:[call]},"success"],
  ["undeclared tool",input,{...output,finishReason:"action_request",actionRequests:[call]},"success"],
  ["error without marker",input,{...output,finishReason:"error"},"failed"],
  ["error invalid marker",input,{message:{role:"assistant",content:"",metadata:{bfclTaskFailure:{reason:"other",code:"refusal"}}},finishReason:"error"},"failed"],
  ["cancelled",input,{...output,finishReason:"cancelled"},"cancelled"],
  ["invalid input",null,output,"failed"],
  ["invalid generation",{...input,generation:{maxTokens:0}},output,"failed"],
  ["invalid output",input,{...output,actionRequests:[call]},"failed"],
  ...["refusal","content_filter","invalid_arguments_json","arguments_not_object"].map(code=>[
    `task failure ${code}`,input,{message:{role:"assistant",content:"",metadata:{bfclTaskFailure:{reason:"model_output",code}}},finishReason:"error"},"success",
  ] as [string,unknown,SampleOutput,string]),
];
for(const [name,request,response,status] of fixtures) test(`SAMPLE ${name}: official parity or exact declared exception, Direct parity`,async()=>{
  const provider:ModelProvider={async invoke(){return structuredClone(response);}};
  const worker=createAgentCoreWorker(await options({providerFactory:()=>provider})).instantiate();
  const official=createInferWorker({providers:{configured:provider},defaultProvider:"configured",timeoutMs:1000}).instantiate();
  const direct=createDirectSteps(await options({providerFactory:()=>provider}));
  try {
    const result:any=await worker.execute(node,request,context()), expected:any=await official.execute(node,request,context());
    assert.equal(result.status,status);
    assert.deepEqual(normalize(result),normalize(await direct.execute(node,request as any)));
    if(name==="undeclared tool") { assert.equal(expected.error.code,"UNDECLARED_ACTION");assert.deepEqual(result.output,response); }
    else if(name.startsWith("task failure")) { assert.equal(expected.error.code,"MODEL_ERROR");assert.deepEqual(result.output,response); }
    else assert.deepEqual(normalize(result),normalize(expected));
  } finally {await worker.dispose?.();await official.dispose?.();await direct.dispose();}
});

for(const mode of ["timeout","external abort"] as const) test(`SAMPLE ${mode}: official and Direct parity, signal reaches provider`,async()=>{
  let signals=0;
  const provider:ModelProvider={invoke(_input,{signal}) {signal.addEventListener("abort",()=>signals++,{once:true});return new Promise(()=>{});}};
  const timeout=mode==="timeout"?30:1000;
  const worker=createAgentCoreWorker(await options({providerFactory:()=>provider,inferenceTimeoutMs:timeout})).instantiate();
  const official=createInferWorker({providers:{configured:provider},timeoutMs:timeout}).instantiate();
  const direct=createDirectSteps(await options({providerFactory:()=>provider,inferenceTimeoutMs:timeout}));
  async function run(execute:(s:AbortSignal)=>Promise<unknown>) {
    const controller=new AbortController();
    const timer=mode==="external abort"?setTimeout(()=>controller.abort(new Error("test cancellation")),10):undefined;
    try {return normalize(await execute(controller.signal));} finally {clearTimeout(timer);}
  }
  try {
    const a:any=await run(s=>worker.execute(node,input,context(s)));
    assert.equal(a.status,mode==="timeout"?"timeout":"cancelled");
    assert.deepEqual(a,await run(s=>official.execute(node,input,context(s))));
    assert.deepEqual(a,await run(s=>direct.execute(node,input,s)));assert.equal(signals,3);
  } finally {await worker.dispose?.();await official.dispose?.();await direct.dispose();}
});

test("SAMPLE provider is fixed to configured; generation defaults and streaming remain official",async()=>{
  let invoked=0;
  const p:ModelProvider={async invoke(i){invoked++;assert.equal(i.generation?.maxTokens,5);return output;}};
  const sample=createBfclSampleExecutor({providers:{configured:p},defaults:{generation:{maxTokens:5}}});
  const a:any=await sample(node,{...input,model:{...input.model,provider:"another"}});
  assert.equal(a.status,"success");assert.equal(invoked,1);
  const original=await createInferWorker({providers:{configured:p},defaults:{generation:{maxTokens:5}}}).instantiate().execute(node,{...input,model:{...input.model,provider:"another"}},context()) as any;
  assert.equal(original.status,"failed");
  const events:any[]=[];
  const streaming:ModelProvider={invoke:async()=>output,async *stream(){yield {type:"text_delta",delta:"ok"};yield {type:"result",output};}};
  const result:any=await createBfclSampleExecutor({providers:{configured:streaming}})(node,input,{},e=>events.push(e));
  assert.equal(result.status,"success");assert.deepEqual(events.map(e=>e.type),["start","text_delta"]);
});

test("SAMPLE source audit: only three behavior edits; executor body identical to official",async()=>{
  const base="tests/fixtures/ditto-v0.1.5/src/worker/infer/";
  const clean=(s:string)=>s.replaceAll("\r\n","\n").replace(/^import .*\n/gm,"").replace(/^\/\/ 来源：.*\n/gm,"");
  let expected=clean(await readFile(base+"reasoning/sample/node.ts.txt","utf8"));
  expected=expected.replace('const name = input.model.provider ?? ctx.defaultProvider;','const name = "configured";')
    .replace('if (output.finishReason === "error") throw','if (output.finishReason === "error" && modelOutputFailureDetails(output)) return output;\n  if (output.finishReason === "error") throw')
    .replace('    const descriptor = input.actions?.find(a => a.name === request.name);\n    if (!descriptor) throw new InferError("UNDECLARED_ACTION", `Model requested undeclared action: ${request.name}`);\n',"");
  assert.equal(clean(await readFile("src/ts/bfcl-sample-node.ts","utf8")),expected);
  const original=(await readFile(base+"worker.ts.txt","utf8")).replaceAll("\r\n","\n");
  const prefix=original.slice(0,original.indexOf("/** Same leaf handlers"));
  assert.equal(clean(await readFile("src/ts/bfcl-sample.ts","utf8")),clean(prefix).replace('function createExecutor(', 'export function createBfclSampleExecutor('));
  console.log("sampleNode: three permitted changes only; createExecutor: body byte-identical after import relocation and exported-name adjustment");
});
