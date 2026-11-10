import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,readdir,cp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { DockerLauncher,containerName } from '../src/ts/docker/launcher.ts';
import { docker,labels,save,directory,inspect } from '../src/ts/docker/common.ts';
import { block,fakeServer,sampleOutput,sleep,command } from './t7-helpers.ts';
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'lifecycle-'));
const evidence=resolve('runs/offline/t8b-20261105/raw',root.split(/[\\/]/).at(-1)!);
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
const runtime={clockTicks:100,pageBytes:4096};const launcher=new DockerLauncher(imageId,runtime);const runId='t8b-lifecycle-'+process.pid;
async function specFor(id:string,url:string){const b=await block(root,url,'Direct',id,1,['multi_turn_base_0']);b.runId=runId;return {runId,unitId:id,block:{...b},outputRoot:root,logDir:join(root,'units',id),guardReportDir:join(root,'guards',id),egressUrl:url};}
async function until(test:()=>Promise<boolean>|boolean){const deadline=Date.now()+90_000;while(!await test()){if(Date.now()>deadline)throw Error('timed out');await sleep(50);}}
try{
  let reply:(()=>void)|undefined;
  const gateway=await fakeServer((_body,res)=>{reply=()=>res.end(JSON.stringify({ok:true,output:sampleOutput}));});
  try{
    const spec=await specFor('stop',gateway.url);const unit=await launcher.start(spec);await until(()=>gateway.requests===1);
    const stopped=unit.stop('test graceful in-flight stop');await until(async()=>{try{return (await readFile(join(spec.logDir,'signals.jsonl'),'utf8')).includes('SIGTERM');}catch{return false;}});await sleep(300);assert.equal(await unit.isAlive(),true);reply!();await stopped;
    const exit=await unit.wait();assert.notEqual(exit.exitCode,0);assert.equal(exit.stoppedByPlan,true);assert.equal(gateway.early,0);
    const failures=await readdir(join(root,'configs','stop','failures'));assert(failures.length);for(const f of failures)assert.equal(JSON.parse(await readFile(join(root,'configs','stop','failures',f),'utf8')).disposition,'interrupted');
    assert.deepEqual(await unit.wait(),exit);console.log(JSON.stringify({test:'SIGTERM',exit,earlyRequestCancellation:gateway.early}));
  }finally{await gateway.close();}
  // Test-only containers never connect to any model; production launch quotas remain unchanged.
  for(const [id,memory,source] of [['kill','4g','import time;time.sleep(600)'],['oom','32m','import time; x=[]\nwhile True: x.append(bytearray(4*1024*1024));time.sleep(0.01)']] as const){
    const spec=await specFor(id,'http://127.0.0.1:1');await directory(spec.logDir);await save(join(spec.logDir,'unit.json'),{spec,imageId,runtime,tag:'dev'});
    const args=['create','--pull=never','--name',containerName(runId,id),...labels(runId,id),'--label',`sec1.log-dir=${spec.logDir}`,'--network','none','--init',`--memory=${memory}`,`--memory-swap=${memory}`,'--pids-limit=64','--cap-drop=ALL','--security-opt','no-new-privileges',imageId,'python3','-B','-c',source];
    const cid=(await docker(args)).stdout.trim();await save(join(spec.logDir,'test-create.json'),args);await docker(['start',cid]);const unit=(await launcher.adopt(runId,id))!;
    if(id==='kill')await unit.kill('network-none test process has zero in-flight requests');const exit=await unit.wait();assert.equal(id==='kill'?exit.killed:exit.oomKilled,true);console.log(JSON.stringify({test:id,exit}));
  }
  let replies:(()=>void)[]=[],release=false;const gateway2=await fakeServer((_body,res)=>{const reply=()=>res.end(JSON.stringify({ok:true,output:sampleOutput}));if(release)reply();else replies.push(reply);});
  try{
    const spec=await specFor('adopt',gateway2.url);const input=join(root,'adopt.json');await save(input,{spec,imageId,runtime});
    const launched=await command(process.execPath,['--experimental-transform-types','tests/t8b-adopt-child.ts',input],join(root,'launch-process.json'));assert.equal(launched.code,0,JSON.stringify(launched));
    await until(()=>gateway2.requests>0);const fresh=new DockerLauncher(imageId,runtime);assert((await fresh.list(runId)).includes('adopt'));const unit=(await fresh.adopt(runId,'adopt'))!;assert(await unit.isAlive());
    const stopping=unit.stop('adopt then graceful stop');await until(async()=>{try{return (await readFile(join(spec.logDir,'signals.jsonl'),'utf8')).includes('SIGTERM');}catch{return false;}});await sleep(300);release=true;for(const reply of replies)reply();await stopping;const exit=await unit.wait();assert.equal(exit.stoppedByPlan,true);assert.equal(gateway2.early,0);assert.deepEqual(await fresh.list(runId),[]);console.log(JSON.stringify({test:'new-process-adopt',exit}));
  }finally{await gateway2.close();}
  console.log('PASS: actual Linux SIGTERM, no in-flight cancellation, kill, OOM, launcher exit and adoption');
}finally{await cp(root,evidence,{recursive:true});if(!(await launcher.list(runId)).length)await rm(root,{recursive:true});}
