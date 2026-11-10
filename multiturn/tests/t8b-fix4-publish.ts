import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {docker,save,labels,removeExited} from '../src/ts/docker/common.ts';
import {publishImage} from '../src/ts/docker/release.ts';
const root=resolve(process.env.SEC1_FIX4_EVIDENCE??'runs/offline/t8b-fix4-20261106','publish-'+process.pid);await mkdir(root,{recursive:true});
const tag=process.env.SEC1_FIX4_TAG??'test-t8b-fix4',imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id;
const sourceTag='test-t8b-fix4-publish',runId='t8b-fix4-publish-'+process.pid,ledger=join(root,'images.json'),manifest=join(root,'tests.json');
const productionLedgerBefore=await readFile('docker/images.json','utf8');
let trial=0;
const commands:any[]=[];
async function d(args:string[],failure=false){const result=await docker(args,failure);commands.push({command:['docker',...args],...result});return result;}
async function clone(suffix:string,context?:string){
  const id=(await d(['create','--pull=never',...labels(runId,suffix),'--network','none',imageId])).stdout.trim();
  try{return (await d(['commit','--change','LABEL sec1.fixture='+suffix,...(context?['--change','LABEL sec1.context='+context]:[]),id,'ditto-sec1-bfcl:'+sourceTag])).stdout.trim();}
  finally{await removeExited(id,runId,suffix);}
}
const invoke=(version='0.0.8404')=>publishImage({version,ledger,tests:manifest,logs:join(root,'logs-'+(++trial)),sourceTag});
async function refused(name:string,pattern:RegExp,version='0.0.8404'){
  const before=await readFile(ledger,'utf8');await assert.rejects(invoke(version),pattern);assert.equal(await readFile(ledger,'utf8'),before);
  if(version!=='dev')assert.notEqual((await d(['image','inspect','ditto-sec1-bfcl:'+version],true)).code,0);
  console.log(JSON.stringify({refused:name,noTag:true,ledgerUnchanged:true}));
}
async function gc(id:string,name:string,apply=false){
  const args=['--import','./scripts/egress-offline-guard.mjs','--experimental-transform-types','scripts/docker-gc.ts','--ledger='+ledger,'--image='+id,...(apply?['--apply']:[])];
  const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});await save(join(root,name+'.json'),{command:['node',...args],code,stdout,stderr});assert.equal(code,0,stderr);return stdout;
}
let good='',bad='';
try{
  good=await clone('good');await save(ledger,[]);await save(manifest,[{name:'actual-test',command:['node','--experimental-transform-types','--test','tests/t8b-fix4-client.test.ts'],log:'client.log'}]);
  await refused('dev',/cannot be dev/,'dev');
  await save(ledger,[{version:'0.0.8404',imageId:good}]);await refused('version in ledger',/already exists/);await save(ledger,[]);
  await d(['tag',good,'ditto-sec1-bfcl:0.0.8404']);await assert.rejects(invoke(),/tag already exists/);assert.deepEqual(JSON.parse(await readFile(ledger,'utf8')),[]);await d(['image','rm','--no-prune','ditto-sec1-bfcl:0.0.8404']);
  console.log('PASS: existing Docker tag rejected, ledger unchanged');
  bad=await clone('bad-context','0'.repeat(64));await refused('image/worktree mismatch',/fingerprint differs/);await d(['tag',good,'ditto-sec1-bfcl:'+sourceTag]);await d(['image','rm','--no-prune',bad]);bad='';
  await save(manifest,[]);await refused('tests never run / empty manifest',/No publish tests/);
  await save(manifest,[{name:'fails',command:['node','-e','process.exit(23)'],log:'failed.log'}]);await refused('test failure',/Publish test failed/);
  const mutation=resolve('tests/t8b-fix4-mutating-fixture.txt');
  await save(manifest,[{name:'mutation',command:['node','-e',`require('node:fs').writeFileSync(${JSON.stringify(mutation)},'changed')`],log:'mutation.log'}]);
  try{await refused('tree changed during test',/Worktree changed/);}finally{await unlink(mutation);}
  await save(manifest,[{name:'client-contract',command:['node','--experimental-transform-types','--test','tests/t8b-fix4-client.test.ts'],log:'client.log'},
    {name:'typecheck',command:['node','node_modules/typescript/lib/tsc.js','-p','tsconfig.json','--noEmit'],log:'typecheck.log'}]);
  const row=await invoke(),info=JSON.parse((await d(['image','inspect','ditto-sec1-bfcl:0.0.8404'])).stdout)[0];
  assert.equal(row.imageId,good);assert.equal(row.imageId,info.Id);assert.equal(row.fingerprint,info.Config.Labels['sec1.context']);assert.equal(row.builtAt,info.Config.Labels['sec1.builtAt']);assert.equal(row.tests.length,2);assert(row.tests.every(t=>t.exitCode===0));assert.equal(row.baseImages.length,2);
  assert.equal(JSON.parse(await readFile(ledger,'utf8')).length,1);await save(join(root,'success-inspect.json'),info);
  await assert.rejects(invoke(),/already exists/);
  // Move the two test tags away; the original image is now dangling without being deleted.
  await d(['tag',imageId,'ditto-sec1-bfcl:'+sourceTag]);await d(['tag',imageId,'ditto-sec1-bfcl:0.0.8404']);
  const preview=await gc(good,'ledger-preview');assert(preview.includes('受台账保护'));const applied=await gc(good,'ledger-apply',true);assert(applied.includes('受台账保护'));assert.equal((await d(['image','inspect',good],true)).code,0);
  await save(join(root,'released-test-ledger.json'),JSON.parse(await readFile(ledger,'utf8')));await save(ledger,[]);assert((await gc(good,'unprotected-delete',true)).includes(good));assert.notEqual((await d(['image','inspect',good],true)).code,0);good='';
  console.log('PASS: complete ledger entry matches inspect; dangling image protected until removed from test ledger');
  await d(['image','rm','--no-prune','ditto-sec1-bfcl:0.0.8404']);
  await save(manifest,[{name:'atomic-precheck',command:['node','--experimental-transform-types','--test','tests/t8b-unit.test.ts'],log:'unit.log'}]);
  const barrier=join(root,'half-written'),args=['--import','./scripts/egress-offline-guard.mjs','--experimental-transform-types','tests/t8b-fix4-publish-child.mjs',ledger,manifest,join(root,'atomic-tests'),barrier];
  const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise<number|null>(r=>child.once('close',r));
  const end=Date.now()+120000;while(!await readFile(barrier,'utf8').catch(()=>'')){assert(Date.now()<end,stdout+stderr);assert(child.exitCode===null,stdout+stderr);await new Promise(r=>setTimeout(r,20));}
  assert.deepEqual(JSON.parse(await readFile(ledger,'utf8')),[]);assert((await readdir(root)).some(n=>n.startsWith('images.json.pending-')));
  child.kill();await done;await save(join(root,'atomic-process.json'),{command:['node',...args],stdout,stderr,exitCode:child.exitCode,signal:child.signalCode});
  assert.deepEqual(JSON.parse(await readFile(ledger,'utf8')),[]);console.log('PASS: killed publisher at half-written pending file; visible ledger stayed []');
  // Crash leaves a conservative lock/tag; evidence retains them and the original ledger.
  assert.equal(await readFile('docker/images.json','utf8'),productionLedgerBefore,'the production ledger, including existing releases, must remain byte-identical');
}finally{
  for(const v of ['0.0.8404','0.0.8405',sourceTag]){const state=await d(['image','inspect','ditto-sec1-bfcl:'+v],true);if(state.code===0)await d(['image','rm','--no-prune','ditto-sec1-bfcl:'+v]);}
  for(const id of [bad,good].filter(Boolean)){if((await d(['image','inspect',id],true)).code===0)await d(['image','rm','--no-prune',id]);}
  await save(join(root,'commands.json'),commands);
}
