import assert from "node:assert/strict";
import {mkdir,readFile,writeFile,readdir} from "node:fs/promises";
import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";
import {block,fakeServer,sampleOutput,command} from "./t7-helpers.ts";
const root=resolve(process.argv[2]),count=Number(process.argv[3]??30),facts:any[]=[];
for(const mode of ["after-call","fatal-reply","before"])for(let i=0;i<(mode==="before"?Math.min(count,10):count);i++){
  const id=mode+"-"+i,part=join(root,id);await mkdir(part,{recursive:true});
  const gateway=await fakeServer((_body,res)=>res.end(JSON.stringify({ok:true,output:sampleOutput})));
  const prior=process.env.NODE_OPTIONS;
  try{
    const b=await block(part,gateway.url,"Uniform",id,1,["multi_turn_base_0","multi_turn_base_4","multi_turn_miss_func_0"]);
    b.copies={Context:1,Infer:1,Interaction:1,Memory:1};b.sampling.enabled=false;
    const config=join(part,"block.json");await writeFile(config,JSON.stringify(b));
    const hook=pathToFileURL(resolve("tests/t7-fix3-race-hook.mjs"));hook.searchParams.set("mode",mode);hook.searchParams.set("out",join(part,"order.jsonl"));
    process.env.NODE_OPTIONS=`${prior??""} --import=${hook.href}`;
    const result=await command(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","src/ts/config-main.ts","--block",config],join(part,"process.json"));
    const directory=join(part,"configs",id),summary=JSON.parse(await readFile(join(directory,"block-summary.json"),"utf8"));
    const failures=await Promise.all((await readdir(join(directory,"failures"))).map(async n=>JSON.parse(await readFile(join(directory,"failures",n),"utf8"))));
    const passed=result.code===1&&summary.notStarted===2&&summary.skipped===0&&summary.interrupted===1&&failures.length===1&&failures[0].category==="Worker 退出"&&failures[0].disposition==="interrupted";
    facts.push({id,passed,summary,failures});console.log(JSON.stringify(facts.at(-1)));
    await writeFile(join(root,"facts.json"),JSON.stringify(facts,null,2));assert(passed,id);
    assert(failures[0].workerLiveness.some((r:any)=>r.workerId==="Infer-1"&&!r.alive));
    assert(failures[0].workerLiveness.every((r:any)=>r.method&&r.confirmedAt));
  }finally{if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior;await gateway.close();}
}
console.log(JSON.stringify({passed:facts.length,total:facts.length}));
