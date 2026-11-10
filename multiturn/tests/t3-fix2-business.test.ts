import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { block, launchBlock, fakeServer, sampleOutput } from "./t7-helpers.ts";

for(const kind of ["input_limit","request_limit","run_stop","length"]) test(`M2 contract-compliant business result: ${kind}`,async()=>{
  const base=process.env.T3_FIX2_EVIDENCE??tmpdir();await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,"t3-fix2-business-"));
  const reply=kind==="length"?{ok:true,output:{...sampleOutput,finishReason:"length"}}:
    {ok:false,error:{kind,message:"fixture "+kind,details:kind==="input_limit"?{inputBytes:1001,maxRequestBytes:1000}:
      kind==="request_limit"?{physicalModelRequests:1,failedModelAttempts:[{id:"fixture-attempt",reason:"transport_unknown",heldReferenceMicroUsd:1,apiMs:1,requestStartedAt:1,rateWaitMs:0,errorCategory:"fixture"}]}:{reason:"fixture stop"}}};
  const server=await fakeServer((_body,res)=>res.end(JSON.stringify(reply)));
  try{
    const b=await block(root,server.url,"Direct",kind,1,["multi_turn_base_0","multi_turn_base_4"]);
    b.perTaskRequests=1;
    const run=await launchBlock(b),done=await run.done;
    const summary=JSON.parse(await readFile(join(run.directory,"block-summary.json"),"utf8"));
    assert.equal(summary.skipped,0);
    if(kind==="run_stop"){
      assert.equal(done.code,1);assert.equal(summary.interrupted,1);assert.equal(summary.notStarted,1);assert.equal(summary.stopCategory,"出口停止");
    }else{
      assert.equal(done.code,0);assert.equal(summary.completed,2);assert.equal(summary.interrupted,0);
      for(const id of b.caseIds){
        const result=JSON.parse(await readFile(join(run.directory,"tasks",id+".r1.json"),"utf8"));
        assert.equal(result.status,"terminated");assert.equal(result.executionOutcome,kind==="length"?"output_limit":kind);
      }
    }
    console.log(JSON.stringify({kind,root,summary,child:done}));
  }finally{await server.close();}
});
