import assert from "node:assert/strict";
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {block,egress,launchBlock,command,python} from "./t7-helpers.ts";
const root=resolve(process.argv[2]);await mkdir(root,{recursive:true});
const cases=["multi_turn_base_0","multi_turn_base_4","multi_turn_miss_func_0","multi_turn_miss_func_4","multi_turn_miss_param_0","multi_turn_miss_param_36","multi_turn_long_context_0","multi_turn_long_context_121"];
const casesFile=join(root,"cases.json");await writeFile(casesFile,JSON.stringify(cases),{flag:"wx"});
const gateway=await egress(root,"replay");
try{
  for(const group of ["Direct","Monolithic","Uniform","Targeted"] as const){
    const b=await block(root,gateway.url,group,group.toLowerCase(),4,cases);
    const run=await launchBlock(b),result=await run.done;assert.equal(result.code,0,JSON.stringify(result));
    for(const c of cases){
      const score=await command(python,["-B","-X","utf8","src/python/score.py","--input",join(run.directory,"tasks",c+".r1.json"),"--output",join(root,group+"-"+c+".score.json")],join(root,group+"-"+c+".process.json"));
      assert.equal(score.code,0,JSON.stringify(score));console.log(JSON.stringify(score));
    }
    console.log(JSON.stringify({group,tasks:8,scoreExit0:8,summary:JSON.parse(await readFile(join(run.directory,"block-summary.json"),"utf8"))}));
  }
}finally{await gateway.close();}
const comparison=await command(python,["-B","-X","utf8","scripts/compare.py","--new-run",root,"--old-run","../../bfcl_direct/runs/multiturn-full800-001","--cases",casesFile,"--output",root+"-comparison"],join(root,"comparison-process.json"));
console.log(comparison.stdout);assert.equal(comparison.code,0,comparison.stderr);
console.log("PASS: four groups x eight cases, strict replay, scoring exit 0, four gates and cross-deployment zero differences");
