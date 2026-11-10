import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {read,ROOT,json} from '../src/ts/scheduler/io.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
const root=resolve(process.argv[2]),split=resolve(process.argv[3]);
for(const name of ['profile','pilot','slice','main']){const stage=read(join(ROOT,'config/stages',name+'.json'));if(stage.targetedSplit)stage.targetedSplit=split;
 const a=freeze(stage,join(root,name+'-a')),b=freeze(stage,join(root,name+'-b'));assert(readFileSync(join(root,name+'-a','plan.json')).equals(readFileSync(join(root,name+'-b','plan.json'))));
 console.log(JSON.stringify({template:name,planHash:a.hash,byteIdentical:true,jobs:a.jobs.length,executions:a.jobs.reduce((n,j)=>n+j.units.reduce((n,u)=>n+u.caseIds.length,0),0)}));
 if(name==='main'){for(const job of a.jobs){assert.equal(job.caseIds.length,50);assert.equal(new Set(job.units.map(u=>u.caseIds.join(','))).size,18);assert.deepEqual(Object.values(job.environmentCounts).sort(),[12,12,13,13]);}json(join(root,'main-blocks.json'),a.jobs.filter(j=>j.round===1).map(j=>({block:j.blockId,environments:j.environmentCounts})),true);console.log(JSON.stringify(read(join(root,'main-blocks.json'))));}
}
