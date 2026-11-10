import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {block,egress,launchBlock,command,python} from './t7-helpers.ts';
const root=resolve(process.argv[2]);await mkdir(root,{recursive:true});
const all=['multi_turn_base_0','multi_turn_base_4','multi_turn_miss_func_0','multi_turn_miss_func_4','multi_turn_miss_param_0','multi_turn_miss_param_36','multi_turn_long_context_0','multi_turn_long_context_121'];
const cases=process.argv[3]==='min'?all.slice(0,1):all;
const casesFile=join(root,'cases.json');await writeFile(casesFile,JSON.stringify(cases),{flag:'wx'});
const gateway=await egress(root,'replay');
try{
  for(const group of ['Direct','Monolithic','Uniform','Targeted'] as const){
    const run=await launchBlock(await block(root,gateway.url,group,group.toLowerCase(),2,cases));
    const proc=await run.done;assert.equal(proc.code,0,JSON.stringify(proc));
    const summary=JSON.parse(await readFile(join(run.directory,'block-summary.json'),'utf8'));
    assert.equal(summary.completed,cases.length);assert.equal(summary.failed,0);
    for(const caseId of cases){
      const score=await command(python,['-B','-X','utf8','src/python/score.py','--input',join(run.directory,'tasks',caseId+'.r1.json'),'--output',join(root,group+'-'+caseId+'.score.json')],join(root,group+'-'+caseId+'.process.json'));
      console.log(JSON.stringify({group,caseId,...score}));assert.equal(score.code,0,score.stderr);
    }
    console.log(JSON.stringify({group,summary,scoreExit0:cases.length}));
  }
}finally{await gateway.close();}
const comparison=await command(python,['-B','-X','utf8','scripts/compare.py','--new-run',root,'--old-run','F:/Academic/Ditto/experiments/bfcl_direct/runs/multiturn-full800-001','--cases',casesFile,'--output',root+'-comparison'],join(root,'comparison-process.json'));
console.log(comparison.stdout);console.log(comparison.stderr);assert.equal(comparison.code,0);
console.log(`PASS four groups x ${cases.length} cases, strict replay, scoring, four gates and cross-deployment`);
