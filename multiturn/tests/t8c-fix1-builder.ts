import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {docker,inspect,assertOwned,labels} from '../src/ts/docker/common.ts';
import {json,env,ROOT} from '../src/ts/scheduler/io.ts';
const root=resolve(process.argv[2]),builder='t8cf1-builder-'+process.pid;mkdirSync(join(root,'runs'),{recursive:true});
const protectedImages=[...new Set((await docker(['image','ls','--all','-q','--no-trunc','--filter','label=sec1.owner=ditto-sec1-bfcl'])).stdout.trim().split(/\s+/).filter(Boolean))];json(join(root,'images.json'),protectedImages.map((imageId,i)=>({version:'fixture-protection-'+i,imageId})));
const image=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0],id=(await docker(['create','--pull=never','--network','none','--label','sec1.owner=ditto-sec1-bfcl','--label','sec1.builder='+builder,image.Id])).stdout.trim();
const foreignRun='foreign-fixture-'+process.pid,foreignUnit='foreign-unit',foreign=(await docker(['create','--pull=never','--network','none',...labels(foreignRun,foreignUnit),'--label','sec1.builder='+builder,image.Id])).stdout.trim();
async function run(before:boolean,apply=false){const script=join(ROOT,before?'before/scripts/docker-gc.ts':'scripts/docker-gc.ts'),args=['--experimental-transform-types',script,'--run='+builder,'--ledger='+join(root,'images.json'),...(apply?['--apply']:[])],child=spawn(process.execPath,args,{cwd:root,windowsHide:true,env:env(join(root,'guards')),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});json(join(root,(before?'before':apply?'applied':'after')+'-process.json'),{command:['node',...args],code,stdout,stderr});assert.equal(code,0,stderr);return stdout;}
try{
 const before=await run(true),after=await run(false);assert(!before.includes(id));assert(after.includes(id));assert.equal((await inspect(id)).State.Running,false);const applied=await run(false,true);assert(applied.includes(id));assert.notEqual((await docker(['inspect',id],true)).code,0);
 const preserved=await inspect(foreign);assertOwned(preserved,foreignRun,foreignUnit);assert.equal(preserved.State.Running,false);assert(applied.split('\n').filter(Boolean).map(l=>JSON.parse(l)).some(r=>r.ignored==='inherited-builder-label'&&r.id===foreign));
 json(join(root,'verification.json'),{status:'PASS',builder,id,foreign,imageId:image.Id,beforeMissed:true,afterDiscovered:true,appliedRemovedOnlyOwnCreatedContainer:true,inheritedBuilderOnForeignRunPreserved:true,allExistingImagesProtectedByFixtureLedger:protectedImages});console.log(JSON.stringify({status:'PASS',builder,id,foreign,inheritedBuilderOnForeignRunPreserved:true}));
}finally{for(const cid of [id,foreign]){const state=await docker(['inspect',cid],true);if(state.code===0){const info=JSON.parse(state.stdout)[0];assertOwned(info);assert.equal(info.Config.Labels['sec1.builder'],builder);assert.equal(info.State.Running,false);await docker(['rm',info.Id]);}}}
