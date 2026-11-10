import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,readFile,readdir,rmdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(process.env.SEC1_FIX4_EVIDENCE??'runs/offline/t8b-fix4-20261106','collection-'+process.pid);
await mkdir(root,{recursive:true});
const commands:any[]=[],original=cp.spawn;let race:undefined|{cid:string;finish:string};
const finishChild=`const {execFileSync:x}=require('node:child_process');x('docker',['cp',process.argv[1],process.argv[2]+':/tmp/finish'],{windowsHide:true});x('docker',['wait',process.argv[2]],{windowsHide:true});try{x('docker',['kill',process.argv[2]],{windowsHide:true,stdio:'pipe'});}catch(e){process.stderr.write(String(e.stderr));process.exit(1);}`;
cp.spawn=((file:any,args:any,options:any)=>{
  let child;
  if(file==='docker'&&args[0]==='kill'&&race){const r=race;race=undefined;child=original(process.execPath,['-e',finishChild,r.finish,r.cid],options);}
  else child=original(file,args,options);
  if(file==='docker'){const record:any={command:['docker',...args],stdout:'',stderr:''};commands.push(record);child.stdout?.on('data',b=>record.stdout+=b);child.stderr?.on('data',b=>record.stderr+=b);child.once('close',code=>record.exitCode=code);}
  return child;
}) as typeof original;syncBuiltinESMExports();
const {DockerLauncher}=await import('../src/ts/docker/launcher.ts');
const {docker,labels,save,assertOwned}=await import('../src/ts/docker/common.ts');
const tag=process.env.SEC1_FIX4_TAG??'test-t8b-fix4';
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id,runtime={clockTicks:100,pageBytes:4096},runId='t8b-fix4-collect-'+process.pid;
const fresh=()=>new DockerLauncher(imageId,runtime,tag);
async function make(name:string,start=true,source='import os\nos._exit(7)'){
  const dir=join(root,name),spec={runId,unitId:name,block:{runId,configId:name},outputRoot:dir,logDir:join(dir,'unit'),guardReportDir:join(dir,'guards'),egressUrl:'http://127.0.0.1:1'};
  await mkdir(spec.logDir,{recursive:true});await save(join(spec.logDir,'unit.json'),{spec,imageId,runtime,tag});
  const cid=(await docker(['create','--pull=never',...labels(runId,name),'--label','sec1.log-dir='+spec.logDir,'--init','--network','none',imageId,'python3','-B','-c',source])).stdout.trim();
  if(start){await docker(['start',cid]);if(!source.includes('/tmp/finish'))await docker(['wait',cid]);}
  return {dir,spec,cid};
}
try{
  for(let i=0;i<3;i++){
    {const t=await make('N9-'+i,false),unit=(await fresh().adopt(runId,t.spec.unitId))!,exit=await unit.wait();
      assert.equal(exit.exitCode,null);assert.equal(exit.startedAt,null);assert.equal(exit.endedAt,null);
      assert.equal((exit as any).collection.neverStarted,true);assert.match(await readFile(join(t.spec.logDir,'exit.json'),'utf8'),/没启动过/);
      assert.equal((await docker(['inspect',t.cid],true)).code,1);console.log(JSON.stringify({test:'N9',iteration:i,exit}));}
    for(const present of [true,false]){const t=await make(`N3-${present}-${i}`),unit=(await fresh().adopt(runId,t.spec.unitId))!;
      await writeFile(join(t.spec.logDir,'exit.json'),'{}');if(!present)await docker(['rm',t.cid]);
      if(present)assert.equal((await unit.wait()).exitCode,7);else await assert.rejects(unit.wait(),/不能补造/);
      const bad=(await readdir(t.spec.logDir)).find(n=>n.startsWith('exit.json.damaged-')&&!n.endsWith('.recovery.json'))!;
      assert.equal(await readFile(join(t.spec.logDir,bad),'utf8'),'{}');
      assert.equal((await readdir(t.spec.logDir)).includes('exit.json'),present);
      console.log(JSON.stringify({test:'N3',iteration:i,present,bad,preservedExact:true}));}
    {const t=await make('N4-'+i),p=join(t.dir,'configs',t.spec.unitId,'block-summary.json');await mkdir(join(t.dir,'configs',t.spec.unitId),{recursive:true});
      await writeFile(p,'{"completed":');const exit=await (await fresh().adopt(runId,t.spec.unitId))!.wait();assert.equal(exit.exitCode,7);assert.equal(exit.summary,null);
      assert.match((exit as any).collection.summaryError,/SyntaxError/);assert.equal(await readFile(p,'utf8'),'{"completed":');
      const kept=(await readdir(join(t.dir,'configs',t.spec.unitId))).find(n=>n.includes('.damaged-')&&!n.endsWith('.recovery.json'))!;
      assert.equal(await readFile(join(t.dir,'configs',t.spec.unitId,kept),'utf8'),'{"completed":');
      assert.equal((await docker(['inspect',t.cid],true)).code,1);console.log(JSON.stringify({test:'N4',iteration:i,exit,preservedExact:true}));}
    {const t=await make('N5-'+i),launcher=fresh(),unit=(await launcher.adopt(runId,t.spec.unitId))!,guard=join(t.spec.logDir,'collector.lock.guard');
      await mkdir(guard);await assert.rejects(unit.wait(),/另一方/);await rmdir(guard);
      assert.equal(await launcher.adopt(runId,t.spec.unitId),unit);const result=await unit.wait();assert.equal(result.exitCode,7);assert.equal(await unit.wait(),result);
      // N12: both methods after collection produce zero commands and zero request files.
      const count=commands.length,before=await readdir(t.spec.logDir);await unit.stop('after');await unit.kill('after');assert.equal(commands.length,count);assert.deepEqual(await readdir(t.spec.logDir),before);
      console.log(JSON.stringify({test:'N5/N12',iteration:i,retriedSameHandle:true,sameResult:true,noDockerCommands:true,noRequestRecords:true}));}
    {const t=await make('N11-'+i,true,"import os,time\nprint('ready',flush=True)\nwhile not os.path.exists('/tmp/finish'):time.sleep(.01)");
      const unit=(await fresh().adopt(runId,t.spec.unitId))!,finish=join(t.dir,'finish');await writeFile(finish,'go');race={cid:t.cid,finish};
      await unit.kill('barrier: process exits between inspect and kill');const request=JSON.parse(await readFile(join(t.spec.logDir,'kill.json'),'utf8')),exit=await unit.wait();
      assert.equal(request.status,'not-running');assert.equal(request.killed,false);assert.equal(exit.killed,false);assert.equal(exit.exitCode,0);
      console.log(JSON.stringify({test:'N11',iteration:i,request,exit}));}
  }
  assert.deepEqual(await fresh().list(runId),[]);console.log('PASS: N9,N3-present,N3-absent,N4,N5,N11,N12 each 3 real-container runs');
}finally{
  race=undefined;
  const ids=(await docker(['ps','-aq','--no-trunc','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+runId])).stdout.trim().split(/\s+/).filter(Boolean);
  for(const id of ids){const info=JSON.parse((await docker(['inspect',id])).stdout)[0];assertOwned(info,runId);if(info.State.Running)await docker(['kill',info.Id]);await docker(['rm',info.Id]);}
  await save(join(root,'commands.json'),commands);cp.spawn=original;syncBuiltinESMExports();
}
