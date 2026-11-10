import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeServer } from "./t7-helpers.ts";
import { input, output } from "./t3-helpers.ts";
import { createModelClient } from "../src/ts/model-client.ts";
const start=performance.now();
const server=await fakeServer((_body,res)=>{void sleep(310_000).then(()=>res.end(JSON.stringify({ok:true,output})));});
try {
  const actual=await createModelClient(server.url).invoke(input,{signal:AbortSignal.timeout(340_000)});
  const elapsedMs=performance.now()-start;
  assert.deepEqual(actual,output);assert(elapsedMs>=310_000);assert.equal(server.early,0);
  console.log(JSON.stringify({elapsedMs,earlyDisconnects:server.early,output:actual,passed:true}));
} finally {await server.close();}
