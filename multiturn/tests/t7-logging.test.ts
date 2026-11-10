import test from "node:test";
import assert from "node:assert/strict";
import { mkdir,writeFile } from "node:fs/promises";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mergeSteps,jsonNew } from "../src/ts/step-log.ts";
import { deployTimeouts } from "../src/ts/deploy-timeouts.ts";
import { validateBlock } from "../src/ts/config-main.ts";
import { temporary,block } from "./t7-helpers.ts";
test("T7 required timeout fields never silently use defaults",async()=>{
  const b=await block(await temporary(),"http://127.0.0.1:1");
  for(const field of ["maxInFlight","requestsPerMinute","minIntervalMs","maxCooldownMs"]){const bad=structuredClone(b);delete (bad.egress.dispatchPolicy as any)[field];assert.throws(()=>validateBlock(bad),/配置无效/);}
  assert.deepEqual(deployTimeouts(b.egress),{modelBridge:379150000,inferenceTimeoutMs:379165000,ipcTimeoutMs:2147483647,cleanupTimeoutMs:2147483647,handshakeTimeoutMs:60000,shutdownTimeoutMs:30000});
});
test("T7 malformed and unmatched log records are all preserved",async()=>{
  const dir=await temporary();await mkdir(join(dir,"workers"));
  await writeFile(join(dir,"parent.steps.jsonl"),'{broken-parent-1\n{broken-parent-2\n');
  await writeFile(join(dir,"workers","x.steps.jsonl"),'{broken-child-1\n{broken-child-2\n{"node":"orphan"}\n');
  const merged=mergeSteps(dir);assert.equal(merged.length,5);assert.equal(merged.filter(r=>r.malformed).length,4);
  assert.equal(new Set(merged.filter(r=>r.malformed).map(r=>r.raw)).size,4);assert(merged.every(r=>r.match!=="matched"));
});
test("T7 partial write cannot publish a task JSON and existing results cannot be overwritten",async()=>{
  const dir=await temporary(),path=join(dir,"task.json"),write=fs.writeFileSync;
  fs.writeFileSync=((fd:any,value:any,...rest:any[])=>{if(typeof fd==="number"){write(fd,String(value).slice(0,4));throw Object.assign(new Error("injected disk full"),{code:"ENOSPC"});}return (write as any)(fd,value,...rest);}) as any;
  syncBuiltinESMExports();
  try{assert.throws(()=>jsonNew(path,{long:"payload"}),/disk full/);assert(!fs.existsSync(path));assert.equal(fs.readdirSync(dir).length,0);}
  finally{fs.writeFileSync=write;syncBuiltinESMExports();}
  jsonNew(path,{first:1});assert.throws(()=>jsonNew(path,{second:2}));assert.deepEqual(JSON.parse(fs.readFileSync(path,"utf8")),{first:1});
});
