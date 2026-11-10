import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { deploy } from "../src/ts/deploy.ts";
import { deployTimeouts } from "../src/ts/deploy-timeouts.ts";
import { block,fakeServer,sampleInput,sampleOutput,alive } from "./t7-helpers.ts";
const directory=resolve(process.argv[2]);await mkdir(directory,{recursive:true});
const server=await fakeServer((_body,res)=>setTimeout(()=>res.end(JSON.stringify({ok:true,output:sampleOutput})),320_000));
const b=await block(directory,server.url,"Monolithic");const timeouts=deployTimeouts(b.egress);
console.log(JSON.stringify(timeouts));assert(timeouts.modelBridge<=timeouts.inferenceTimeoutMs&&timeouts.inferenceTimeoutMs<=timeouts.ipcTimeoutMs);
const pool=await deploy({group:"Monolithic",copies:{All:1},python:b.python,modelEndpoint:server.url,directory,timeouts});
try{
  const start=performance.now();const result=await pool.runtime.invoke("INFER.REASONING.SAMPLE",sampleInput as any);
  assert.equal(result.status,"success");assert.equal(server.early,0);assert(performance.now()-start>=320_000);
  console.log(JSON.stringify({success:true,elapsedMs:performance.now()-start,earlyDisconnects:server.early,requests:server.requests}));
}finally{await pool.close();await server.close();}
assert(pool.units.every(u=>!alive(u.child.pid!)));console.log("PASS: 320s parent -> IPC -> SAMPLE -> HTTP, no early disconnect, all workers exited");
