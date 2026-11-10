import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir,mkdtemp,readFile,readdir,cp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { DockerLauncher } from '../src/ts/docker/launcher.ts';
import { docker,inspect,save,labels,directory } from '../src/ts/docker/common.ts';
import { block,fakeServer,sampleOutput,sleep,command } from './t7-helpers.ts';
const evidence=resolve(process.env.T8B_FIX_EVIDENCE??'runs/offline/t8b-fix-20261105');
const root=await mkdtemp(join(tmpdir(),'t8b-fix-cases-')),runId='t8b-fix-'+process.pid;
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
const runtime={clockTicks:100,pageBytes:4096};
const launcher=()=>new DockerLauncher(imageId,runtime);
async function until(test:()=>Promise<boolean>|boolean){const deadline=Date.now()+90000;while(!await test()){if(Date.now()>deadline)throw Error('Timed out');await sleep(50);}}
async function specFor(id:string,url:string){const b=await block(root,url,'Direct',id,1,['multi_turn_base_0']);b.runId=runId;return {runId,unitId:id,block:{...b},outputRoot:root,logDir:join(root,'units',id),guardReportDir:join(root,'guards',id),egressUrl:url};}
async function toy(id:string,source:string){
  const spec=await specFor(id,'http://127.0.0.1:1');await directory(spec.logDir);await save(join(spec.logDir,'unit.json'),{spec,imageId,runtime,tag:'dev'});
  const cid=(await docker(['create','--pull=never',...labels(runId,id),'--label',`sec1.log-dir=${spec.logDir}`,'--network','none',imageId,'python3','-B','-c',source])).stdout.trim();
  await docker(['start',cid]);return {spec,cid,unit:(await launcher().adopt(runId,id))!};
}
try{
  const repeats=process.argv.includes('--minimal')?1:3;
  for(const state of ['running','exited'])for(let i=0;i<repeats;i++){
    let release=false;const replies:(()=>void)[]=[];
    const gateway=await fakeServer((_body,res)=>{const reply=()=>res.end(JSON.stringify({ok:true,output:sampleOutput}));if(release)reply();else replies.push(reply);});
    try{
      const spec=await specFor(`${state}-${i}`,gateway.url),input=join(root,`${state}-${i}.json`);await save(input,{spec,imageId,runtime});
      const child=await command(process.execPath,['--experimental-transform-types','tests/t8b-fix-wait-child.ts',input],input+'.process.json');assert.equal(child.code,0,JSON.stringify(child));
      await until(()=>gateway.requests>0);
      const lock=JSON.parse(await readFile(join(spec.logDir,'child-lock.json'),'utf8'));
      assert.equal((await inspect(lock.containerId)).Id,lock.containerId);
      const finish=()=>{release=true;for(const reply of replies)reply();};
      if(state==='exited'){finish();await docker(['wait',lock.containerId]);}
      const fresh=launcher();assert((await fresh.list(runId)).includes(spec.unitId));
      const unit=(await fresh.adopt(runId,spec.unitId))!;assert.equal(await unit.isAlive(),state==='running');
      assert.equal(await fresh.adopt(runId,spec.unitId),unit,'canonical handle cache');
      const waiting=unit.wait();if(state==='running')finish();const exit=await waiting;
      assert.equal(exit.exitCode,0);assert.equal(exit.oomKilled,false);assert.equal(exit.killed,false);assert.equal(exit.stoppedByPlan,false);
      assert(Date.parse(exit.startedAt)>0);assert(Date.parse(exit.endedAt)>=Date.parse(exit.startedAt));assert.equal((exit.summary as any).completed,1);
      assert.deepEqual(await unit.wait(),exit);assert.equal((await docker(['inspect',lock.containerId],true)).code,1);
      console.log(JSON.stringify({test:'M1',state,iteration:i+1,lock,exit,containerRemoved:true}));
    }finally{await gateway.close();}
  }
  const mismatch=await toy('mismatch','pass');await docker(['wait',mismatch.cid]);
  const wrong=await toy('wrong-identity','pass');await docker(['wait',wrong.cid]);
  await save(join(mismatch.spec.logDir,'collector.lock'),{pid:2147483647,containerId:wrong.cid});
  await assert.rejects(mismatch.unit.wait(),/Collector identity mismatch/);console.log('PASS: real distinct full container ID rejected');
  await rm(join(mismatch.spec.logDir,'collector.lock'));await (await launcher().adopt(runId,'mismatch'))!.wait();await wrong.unit.wait();
  for(const kind of ['kill','stop'] as const){
    const t=await toy(kind+'-failed',"import os,time\nwhile not os.path.exists('/tmp/finish'): time.sleep(.05)");
    const original=childProcess.spawn;
    childProcess.spawn=((file:any,args:any,options:any)=>file==='docker'&&(kind==='kill'?args[0]==='kill'&&!args.includes('--signal=SIGTERM'):args[0]==='kill'&&args.includes('--signal=SIGTERM'))?original(process.execPath,['-e',"process.stderr.write('injected delivery failure');process.exit(23)"],options):original(file,args,options)) as typeof original;
    syncBuiltinESMExports();
    const waiting=t.unit.wait();
    try{await assert.rejects(t.unit[kind]('injected undelivered request'),/injected delivery failure/);}
    finally{childProcess.spawn=original;syncBuiltinESMExports();}
    await docker(['exec',t.cid,'python3','-B','-c',"open('/tmp/finish','w').close()"]);
    const exit=await waiting,request=JSON.parse(await readFile(join(t.spec.logDir,kind+'.json'),'utf8'));
    assert.equal(exit.exitCode,0);assert.equal(exit.killed,false);assert.equal(exit.signal,null);assert.equal(exit.stoppedByPlan,kind==='stop');
    assert.equal(request.status,'failed');assert.match(request.error,/injected delivery failure/);console.log(JSON.stringify({test:kind+'-failed',exit,request}));
  }
  const real=await toy('real-kill','import time;time.sleep(600)');const waiting=real.unit.wait();
  const kill=real.unit.kill('zero model requests');assert.equal(real.unit.kill('duplicate request'),kill,'concurrent kill shares delivery');await kill;const exit=await waiting;
  assert.equal(exit.exitCode,137);assert.equal(exit.killed,true);assert.equal(exit.signal,'SIGKILL');assert.equal(exit.oomKilled,false);
  const request=JSON.parse(await readFile(join(real.spec.logDir,'kill.json'),'utf8'));assert.equal(request.status,'succeeded');console.log(JSON.stringify({test:'real-kill',exit,request}));
  const cross=await toy('cross-handle-kill','import time;time.sleep(600)');
  const other=(await launcher().adopt(runId,'cross-handle-kill'))!;
  const original=childProcess.spawn;let sends=0;
  childProcess.spawn=((file:any,args:any,options:any)=>{
    if(file!=='docker'||args[0]!=='kill')return original(file,args,options);
    sends++;
    return sends===1?original(process.execPath,['-e',"setTimeout(()=>{require('node:child_process').execFileSync(process.argv[1],process.argv.slice(2),{stdio:'inherit',windowsHide:true});},500)",'docker',...args],options)
      :original(process.execPath,['-e',"setTimeout(()=>{process.stderr.write('injected second-handle failure');process.exit(23)},1000)"],options);
  }) as typeof original;syncBuiltinESMExports();
  try{
    const attempts=await Promise.allSettled([cross.unit.kill('first delivery'),other.kill('second delivery fails')]);
    assert.deepEqual(attempts.map(a=>a.status).sort(),['fulfilled','rejected']);assert.equal(sends,2);
  }finally{childProcess.spawn=original;syncBuiltinESMExports();}
  const crossExit=await cross.unit.wait();assert.equal(crossExit.killed,true);assert.equal(crossExit.exitCode,137);
  const history=join(cross.spec.logDir,'kill-requests');
  const records=await Promise.all((await readdir(history)).map(n=>readFile(join(history,n),'utf8').then(JSON.parse)));
  assert.deepEqual(records.map(r=>r.status).sort(),['failed','succeeded']);assert(records.some(r=>r.error?.includes('second-handle failure')));
  console.log(JSON.stringify({test:'cross-handle-kill',exit:crossExit,records}));
  assert.deepEqual(await launcher().list(runId),[]);console.log('PASS: M1, wrong identity, M2 successful/failed delivery and planned-stop request semantics');
}finally{await cp(root,join(evidence,root.split(/[\\/]/).at(-1)!),{recursive:true});}
