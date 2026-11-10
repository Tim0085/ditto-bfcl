import test from "node:test";
import assert from "node:assert/strict";
import {writeFileSync,readFileSync,appendFileSync,mkdirSync} from "node:fs";
import {join,resolve} from "node:path";
import {deploy} from "../src/ts/deploy.ts";
import {deployTimeouts} from "../src/ts/deploy-timeouts.ts";
import {lines,recordingFailures,log} from "../src/ts/step-log.ts";
import {runBlock} from "../src/ts/config-main.ts";
import {temporary,block,fakeServer,sampleOutput,command,python} from "./t7-helpers.ts";

test("M2 binding failure commits no assignment; later choices and counts match baseline",async()=>{
  for(const group of ["Monolithic","Uniform","Targeted"] as const){
    const root=await temporary(),b=await block(root,"http://127.0.0.1:1",group);
    const pool=await deploy({group,copies:b.copies!,python:b.python,modelEndpoint:b.modelEndpoint,directory:root,timeouts:deployTimeouts(b.egress)});
    try{
      const first=pool.attach("baseline"),counts=pool.units.map(u=>u.assigned);pool.detach("baseline");
      const workers=pool.runtime.workers.bind(pool.runtime);
      pool.runtime.workers=()=>[];
      assert.throws(()=>pool.attach("bad"),/Binding lacks capability/);
      assert(pool.units.every(u=>u.assigned===0));pool.detach("bad");
      pool.runtime.workers=workers;
      const next=pool.attach("next");
      assert.deepEqual(next,first);assert.deepEqual(pool.units.map(u=>u.assigned),counts);
      pool.detach("next");assert(pool.units.every(u=>u.assigned===0));
      console.log(JSON.stringify({group,assignment:next.assignment,counts,afterDetach:pool.units.map(u=>u.assigned)}));
    }finally{await pool.close();}
  }
});
test("M3 two physical bad lines reread four times count 2 dropped / 8 discoveries; write failures still count individually",async()=>{
  const root=await temporary(),file=join(root,"bad.jsonl");
  writeFileSync(file,'\n{broken\n\n[]\n');
  for(let i=0;i<4;i++){
    const rows=lines(file);assert.deepEqual(rows.map(x=>x.line),[2,4]);
  }
  assert.equal(recordingFailures()[file].droppedRecords,2);assert.equal(recordingFailures()[file].count,8);
  const blocked=join(root,"directory");mkdirSync(blocked);
  for(let i=0;i<3;i++)log(blocked,{i});
  assert.equal(recordingFailures()[blocked].droppedRecords,3);assert.equal(recordingFailures()[blocked].count,3);
  console.log(JSON.stringify({bad:recordingFailures()[file],write:recordingFailures()[blocked]}));
});
test("M3 block summary includes unique loss/discovery counts and results still score",async()=>{
  const root=await temporary();let seeded=false;
  const path=join(root,"configs","corrupt","direct.steps.jsonl");
  const server=await fakeServer((_body,res)=>{
    if(!seeded){seeded=true;appendFileSync(path,'bad-1\n\nbad-2\n');}
    res.end(JSON.stringify({ok:true,output:sampleOutput}));
  });
  try{
    const b=await block(root,server.url,"Direct","corrupt",1,["multi_turn_base_0","multi_turn_base_4","multi_turn_base_6"]);
    const summary=await runBlock(b),disk=JSON.parse(readFileSync(join(root,"configs","corrupt","block-summary.json"),"utf8"));
    assert.equal(summary.exitCode,0);assert.equal(summary.completed,3);
    assert.equal(disk.recordingFailures[path].droppedRecords,2);assert.equal(disk.recordingFailures[path].count,8);
    for(const c of b.caseIds){
      const r=await command(python,["-B","-X","utf8","src/python/score.py","--input",join(root,"configs","corrupt","tasks",c+".r1.json"),"--output",join(root,c+".score.json")],join(root,c+".process.json"));
      assert.equal(r.code,0,JSON.stringify(r));console.log(JSON.stringify(r));
    }
    console.log(JSON.stringify({root,recordingFailures:disk.recordingFailures[path],completed:3}));
  }finally{await server.close();}
});
