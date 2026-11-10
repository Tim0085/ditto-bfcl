import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {catalog,categories,primary,shuffle,profileNumbers,generate} from '../src/ts/scheduler/plan.ts';
import {read,json} from '../src/ts/scheduler/io.ts';
const tasks=catalog(),excluded=new Set([...profileNumbers,3,6,9,12,16,25]);
const template=read('config/stages/slice.json'),cases:string[]=[],proof:any[]=[];
for(const category of categories){
  const pools=primary.map(environment=>shuffle(tasks.filter(t=>t.id.startsWith(category+'_')&&t.involved_classes.includes(environment)&&!excluded.has(Number(t.id.split('_').at(-1)))).map(t=>t.id),`${template.seed}/${category}/${environment}`));
  const selected:string[]=[];while(selected.length<5)for(const pool of pools){if(pool.length&&selected.length<5)selected.push(pool.shift()!);}
  cases.push(...selected);proof.push({category,selected,environmentCounts:Object.fromEntries(primary.map(e=>[e,selected.filter(id=>tasks.find(t=>t.id===id).involved_classes.includes(e)).length]))});
}
if(process.argv.includes('--write')){
  for(const b of template.batches)b.caseIds=cases;
  writeFileSync('config/stages/slice.json',JSON.stringify(template,null,2)+'\n');
  const v2=read('config/stages/t8c-slice-exp1-v1.json');v2.runId='t8c-slice-exp1-v2';v2.launcher.tag='exp1-v2';delete v2.launcher.imageId;
  for(const b of v2.batches)b.caseIds=cases;
  writeFileSync('config/stages/t8c-slice-exp1-v2.json',JSON.stringify(v2,null,2)+'\n');
}
const stage=read('config/stages/t8c-slice-exp1-v2.json');
// generate only validates the planned shape; no lock, Docker call or execution.
stage.launcher.imageId='sha256:'+'a'.repeat(64);const plan=generate(stage);
assert.equal(plan.jobs.reduce((n,j)=>n+j.caseIds.length*j.units.length,0),380);
for(const batch of stage.batches){assert.deepEqual(batch.caseIds,cases);for(const category of categories)assert.equal(batch.caseIds.filter((id:string)=>id.startsWith(category+'_')).length,5);}
assert(plan.jobs.every(j=>primary.every(e=>j.environmentCounts[e]>0)));
assert(cases.every(id=>!excluded.has(Number(id.split('_').at(-1)))));
const before=existsSync('before/config/stages/slice.json')?JSON.parse(readFileSync('before/config/stages/slice.json','utf8')):null;
json('runs/offline/t8c-fix1-20261106/slice-selection.json',{rule:'Same seed/category/environment shuffle as main plan, after excluding profiling and development numbers; round-robin through primary environments, take first five per category',seed:template.seed,excluded:[...excluded].sort((a,b)=>a-b),before:before?.batches[0].caseIds.map((id:string)=>({id,environments:tasks.find(t=>t.id===id).involved_classes}))??null,after:proof,total:380,notExecuted:true});
console.log(JSON.stringify({status:'PASS',total:380,notExecuted:true,proof}));
