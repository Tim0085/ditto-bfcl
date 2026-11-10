import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { block,egress,launchBlock,temporary,command,python } from "./t7-helpers.ts";
test("T7 real subprocess fixture, Direct and Monolithic results are directly scoreable",async()=>{
  const root=await temporary(),gateway=await egress(root,"fixtures");
  try{
    for(const group of ["Direct","Monolithic"] as const){
      const b=await block(root,gateway.url,group,group);const run=await launchBlock(b),done=await run.done;
      assert.equal(done.code,0,JSON.stringify(done));
      const path=join(run.directory,"tasks","multi_turn_base_0.r1.json"),result=JSON.parse(await readFile(path,"utf8"));
      assert.equal(result.status,"completed");assert(result.workerEvents.length>0);
      const score=await command(python,["-B","-X","utf8","src/python/score.py","--input",path,"--output",join(root,group+".score.json")],join(root,group+".score-process.json"));
      assert.equal(score.code,0,JSON.stringify(score));console.log(JSON.stringify({group,code:done.code,events:result.workerEvents.length,score:score.stdout}));
    }
  }finally{await gateway.close();}
});
