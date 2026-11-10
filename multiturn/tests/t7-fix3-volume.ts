import assert from "node:assert/strict";
import {mkdirSync,appendFileSync,readFileSync,readdirSync} from "node:fs";
import {resolve,join} from "node:path";
import {runBlock} from "../src/ts/config-main.ts";
import {block,fakeServer,sampleOutput,command,python} from "./t7-helpers.ts";
const root=resolve(process.argv[2]),mode=process.argv[3]??"volume";
mkdirSync(root,{recursive:true});let seeded=false;
const server=await fakeServer((_body,res)=>{
  if(!seeded){seeded=true;
    const row={taskId:"previous/task",direct:true,node:"CONTEXT.SELECT",started:{ns:mode==="merge-error"?"invalid":"1"},ended:{ns:"2"}};
    appendFileSync(join(root,"configs","volume","direct.steps.jsonl"),(JSON.stringify(row)+"\n").repeat(mode==="volume"?250000:1));
  }
  res.end(JSON.stringify({ok:true,output:sampleOutput}));
});
try{
  const b=await block(root,server.url,"Direct","volume",1,["multi_turn_base_0","multi_turn_base_4"]);
  const summary=await runBlock(b),dir=join(root,"configs","volume");
  console.log(JSON.stringify(summary));assert.equal(summary.exitCode,0);assert.equal(summary.completed,1);assert.equal(summary.skipped,1);
  assert.equal(readdirSync(join(dir,"tasks")).length,1);assert.equal(readdirSync(join(dir,"failures")).length,1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,"block-summary.json"),"utf8")),summary);
  if(mode==="volume")assert(readFileSync(join(dir,"steps.jsonl"),"utf8").split("\n").length>250000);
  else assert(Object.values(summary.recordingFailures).some((v:any)=>/BigInt/.test(v.reason)));
  const result=await command(python,["-B","-X","utf8","src/python/score.py","--input",join(dir,"tasks","multi_turn_base_0.r1.json"),"--output",join(root,"score.json")],join(root,"score-process.json"));
  assert.equal(result.code,0,JSON.stringify(result));console.log(JSON.stringify({mode,score:result,passed:true}));
}finally{await server.close();}
