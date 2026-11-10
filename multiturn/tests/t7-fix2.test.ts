import test from "node:test";
import assert from "node:assert/strict";
import { readFile,writeFile,readdir,mkdir,cp } from "node:fs/promises";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { block,temporary,egress,command,python,fakeServer,sampleOutput,sleep } from "./t7-helpers.ts";
import { lines } from "../src/ts/step-log.ts";
const cases=["multi_turn_base_0","multi_turn_base_4","multi_turn_miss_func_0","multi_turn_miss_func_4","multi_turn_miss_param_0","multi_turn_miss_param_36","multi_turn_long_context_0","multi_turn_long_context_121"];
const read=async(path:string)=>JSON.parse(await readFile(path,"utf8"));
async function run(root:string,url:string,id:string,group:any,c:number,ids:string[],faults:any[]=[],mode?:string){
  const b=await block(root,url,group,id,c,ids);if(group==="Monolithic")b.copies={All:1};
  const config=join(root,id+".json");await writeFile(config,JSON.stringify(b));
  const hook=pathToFileURL(resolve("tests/t7-fix2-hook.mjs"));hook.searchParams.set("faults",JSON.stringify(faults));
  const old=process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS=`${old??""} --import=${hook.href}`;
  let result;
  try{result=await command(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types",...(mode?["tests/t7-fault-runner.ts",config,mode]:["src/ts/config-main.ts","--block",config])],join(root,id+".process.json"));}
  finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
  const dir=join(root,"configs",id),summary=await read(join(dir,"block-summary.json"));
  const failures=await Promise.all((await readdir(join(dir,"failures"))).map(n=>read(join(dir,"failures",n))));
  assert.equal(summary.failed,summary.skipped+summary.interrupted);
  assert.equal(result.code,summary.exitCode);
  console.log(JSON.stringify({id,summary,failures:failures.map(f=>({caseId:f.caseId,disposition:f.disposition,failureType:f.failureType,streak:f.streak,category:f.category}))}));
  return {dir,summary,failures};
}
async function score(root:string,dir:string,ids:string[]){
  for(const id of ids){const out=join(root,dir.split(/[\\/]/).at(-1)+id+".score.json");
    const r=await command(python,["-B","-X","utf8","src/python/score.py","--input",join(dir,"tasks",id+".r1.json"),"--output",out],out+".process.json");assert.equal(r.code,0,JSON.stringify(r));
    const old=await read(`../../bfcl_direct/runs/multiturn-full800-001/full/${id.replace(/_\d+$/,"")}/monolithic/monolithic-c1/score.json`);
    const actual=await read(out),expected=old.results.find((r:any)=>r.caseId===id);assert(expected);assert.equal(actual.valid,expected.valid);assert.deepEqual(actual.official_result,expected.official_result);
  }
}
async function compare(root:string,ids:string[],label:string){
  const path=join(root,label+".cases.json");await writeFile(path,JSON.stringify(ids));
  const r=await command(python,["-B","-X","utf8","scripts/compare.py","--new-run",root,"--old-run","../../bfcl_direct/runs/multiturn-full800-001","--cases",path,"--output",root+"-"+label],join(root,label+".compare-process.json"));
  console.log(JSON.stringify({comparison:label,...r}));assert.equal(r.code,0,JSON.stringify(r));
}
test("T7 fix2 four groups replay, single skip, following same-worker tasks score and match",async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));const gateway=await egress(root,"replay");
  try{
    const normal=join(root,"normal");await mkdir(normal);
    for(const group of ["Direct","Monolithic","Uniform","Targeted"]){const r=await run(normal,gateway.url,group,group,1,cases);assert.equal(r.summary.completed,8);assert.equal(r.summary.skipped,0);assert.equal(r.summary.exitCode,0);await score(normal,r.dir,cases);}
    await cp(join(root,"egress"),join(normal,"egress"),{recursive:true});
    await compare(normal,cases,"normal");
    for(const [group,type] of [["Monolithic","context-error"],["Direct","tool-channel"],["Uniform","sample-not-success"]]){
      const part=join(root,type);await mkdir(part);const bad=cases[1],ids=cases.filter(x=>x!==bad);
      const r=await run(part,gateway.url,"fault-"+type,group,1,cases,[{caseId:bad,type}]);
      assert.equal(r.summary.exitCode,0);assert.equal(r.summary.completed,7);assert.equal(r.summary.skipped,1);assert.equal(r.summary.interrupted,0);assert.equal(r.summary.skippedByCategory.base,1);
      assert.equal(r.failures[0].failureType,type);assert.equal(r.failures[0].disposition,"skipped");assert.equal(r.failures[0].streak,1);
      await score(part,r.dir,ids);
      // Include the baseline in cross-deployment comparisons over exactly the surviving cases.
      await cp(join(normal,"configs",group),join(part,"configs",group),{recursive:true});
      await cp(join(root,"egress"),join(part,"egress"),{recursive:true});
      await compare(part,ids,"survivors");
      if(group!=="Direct"){
        const failed=r.failures[0],after=await read(join(r.dir,"tasks",cases[2]+".r1.json"));
        assert.deepEqual(after.assignment,failed.assignment);
      }
    }
  }finally{await gateway.close();}
});
test("T7 fix2 completion streak, first error, structured statuses, interrupted concurrency",async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));const gateway=await egress(root,"replay");
  try{
    for(const [id,types,expected] of [
      ["adjacent",["context-error","context-error"],1],
      ["reset",["context-error",null,"context-error"],0],
      ["different",["context-error","sample-not-success"],0],
      ["memory",[null,"memory-not-success"],0],
      ["cleanup",[null,"cleanup"],0],
      ["context-invalid",[null,"context-invalid"],0],
      ["first",[null,"context-error"],0],
    ] as const){
      const faults=types.flatMap((type,i)=>type?[{caseId:cases[i],type,extraCleanup:id==="first",status:"timeout"}]:[]);
      const r=await run(root,gateway.url,id,"Monolithic",1,cases.slice(0,4),faults);
      assert.equal(r.summary.exitCode,expected);
      if(expected){assert.equal(r.summary.notStarted,2);assert.deepEqual(r.summary.consecutiveFailure,{failureType:"context-error",caseIds:cases.slice(0,2)});assert(cases.slice(0,2).every(c=>r.summary.stopReason.includes(c)));}
      else{assert.equal(r.summary.notStarted,0);assert(r.failures.every(f=>f.streak===1));}
      if(id==="memory"||id==="cleanup")assert.equal(r.failures[0].failureType,id==="memory"?"memory-not-success":"cleanup");
      if(id==="first"){assert.equal(r.failures[0].failureType,"context-error");assert.equal(r.failures[0].errors.length,2);}
      if(id==="context-invalid")assert.equal(r.failures[0].failureType,"context-error");
    }
    const r=await run(root,gateway.url,"concurrent","Direct",4,cases,cases.map((caseId,i)=>({caseId,type:i<2?"context-error":"none",delay:i<2?150:900})));
    assert.equal(r.summary.exitCode,1);assert.equal(r.summary.skipped,2);assert(r.summary.interrupted>=2);assert.equal(r.summary.notStarted,3);
    assert(r.failures.filter(f=>f.disposition==="interrupted").every(f=>f.streak===2));
    const reliable=await run(root,gateway.url,"reliable-single","Direct",1,[cases[0]],[],"score-channel");
    assert.equal(reliable.summary.exitCode,0);assert.equal(reliable.failures[0].failureType,"scoring-trace");assert.equal(reliable.failures[0].disposition,"skipped");
    const validate=await run(root,gateway.url,"trace-validate","Monolithic",1,cases.slice(0,3),[],"trace-validate");
    assert.equal(validate.summary.exitCode,0);assert.equal(validate.summary.completed,2);assert.equal(validate.failures[0].failureType,"scoring-trace");
    for(const status of ["failed","cancelled"]){
      const sample=await run(root,gateway.url,status,"Direct",1,cases.slice(0,3),[{caseId:cases[1],type:"sample-not-success",status}]);
      assert.equal(sample.summary.exitCode,0);assert.equal(sample.failures[0].failureType,"sample-not-success");assert.equal(sample.failures[0].failureNode.status,status);
    }
    const lost=await run(root,gateway.url,"failure-write","Direct",1,cases.slice(0,3),[{caseId:cases[0],type:"context-error"}],"failure-write");
    assert.equal(lost.summary.exitCode,1);assert.equal(lost.summary.skipped,0);assert.equal(lost.summary.interrupted,1);assert.equal(lost.summary.notStarted,2);assert.equal(lost.failures.length,0);assert.equal(lost.summary.consecutiveFailure,null);
    const first=await run(root,gateway.url,"first-tool-score","Direct",1,cases.slice(0,3),[{caseId:cases[1],type:"tool-channel",extraCleanup:true}],"score-after-error");
    assert.equal(first.summary.exitCode,0);assert.equal(first.failures[0].failureType,"tool-channel");assert.equal(first.failures[0].errors.length,3);
    assert.match(first.failures[0].errors[0],/injected tool channel/);assert.match(first.failures[0].errors[1],/secondary scoring/);assert.match(first.failures[0].errors[2],/injected cleanup/);
    const failedScore=await run(root,gateway.url,"first-sample-score","Monolithic",1,cases.slice(0,3),[{caseId:cases[1],type:"sample-not-success",status:"failed"}],"score-after-error");
    assert.equal(failedScore.summary.exitCode,0);assert.equal(failedScore.failures[0].failureType,"sample-not-success");assert.equal(failedScore.failures[0].errors.length,2);
  }finally{await gateway.close();}
});
test("T7 fix2 Worker kill race ten repetitions, run_stop, SIGTERM",async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));
  for(let i=0;i<12;i++){
    const mode=i<10?"kill":i===10?"run_stop":"sigterm",id=mode+i;let killed=false;
    const server=await fakeServer((_body,res)=>{void(async()=>{
      if(mode==="kill"&&!killed){killed=true;const worker=lines(join(root,"configs",id,"parent.steps.jsonl")).find(p=>p.workerId==="All-1");assert(worker);process.kill(worker.pid,"SIGKILL");}
      if(mode==="sigterm")await writeFile(join(root,"signal-ready"),"");
      await sleep(120);res.end(JSON.stringify(mode==="run_stop"?{ok:false,error:{kind:"run_stop",details:{reason:"test"}}}:{ok:true,output:sampleOutput}));
    })();});
    try{
      const r=await run(root,server.url,id,"Monolithic",1,cases.slice(0,3),[],mode==="sigterm"?mode:undefined);
      assert.equal(r.summary.exitCode,1);assert.equal(r.summary.notStarted,2);assert.equal(r.summary.skipped,0);assert.equal(r.summary.interrupted,1);
      assert.equal(r.failures[0].disposition,"interrupted");assert.equal(r.failures[0].category,mode==="kill"?"Worker 退出":mode==="run_stop"?"出口停止":"被停止");assert.equal(r.failures[0].streak,0);
      if(mode!=="kill")assert.equal(server.early,0);
    }finally{await server.close();}
  }
});
