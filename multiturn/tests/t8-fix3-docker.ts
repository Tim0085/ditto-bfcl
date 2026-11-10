import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {DockerLauncher} from '../src/ts/docker/launcher.ts';
import {docker,save,labels,assertOwned} from '../src/ts/docker/common.ts';
const root=resolve(process.argv[2]);await mkdir(root,{recursive:true});const runId='t8fix3-'+process.pid;
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id,runtime={clockTicks:100,pageBytes:4096};
const fresh=()=>new DockerLauncher(imageId,runtime);
const exists=(p:string)=>access(p).then(()=>true,()=>false);
async function toy(name:string){const dir=join(root,name),spec={runId,unitId:name,logDir:join(dir,'unit'),outputRoot:dir,guardReportDir:join(dir,'guards'),block:{runId,configId:name},egressUrl:'http://127.0.0.1:1'};await mkdir(spec.logDir,{recursive:true});await save(join(spec.logDir,'unit.json'),{spec,imageId,runtime,tag:'dev'});const cid=(await docker(['create','--pull=never',...labels(runId,name),'--label','sec1.log-dir='+spec.logDir,'--network','none',imageId,'python3','-B','-c','pass'])).stdout.trim();await docker(['start',cid]);await docker(['wait',cid]);return {root:dir,spec,cid,imageId,runtime};}
try{
 const t=await toy('crash');await save(join(t.root,'input.json'),t);
 const args=['--experimental-transform-types','tests/t8-fix3-child.mjs','docker',join(t.root,'input.json')];const p=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const done=new Promise(r=>p.once('close',r));
 try{const deadline=Date.now()+60000;while(!await exists(join(t.root,'partial-written'))){assert(Date.now()<deadline);assert.equal(p.exitCode,null,stderr);await new Promise(r=>setTimeout(r,20));}assert.equal(await exists(join(t.spec.logDir,'exit.json')),false);p.kill();const code=await done;await save(join(t.root,'killed-process.json'),{args,code,stdout,stderr});const unit=await fresh().adopt(runId,t.spec.unitId);assert.equal((await unit!.wait()).exitCode,0);assert.equal((await docker(['inspect',t.cid],true)).code,1);console.log('PASS killed partial collector / fresh adoption / collection / removal');}finally{if(p.exitCode===null){p.kill();await done;}}
 for(const state of ['present','absent']){
  const t=await toy(state),unit=(await fresh().adopt(runId,t.spec.unitId))!;const bad='{"exitCode":0,"sig';await writeFile(join(t.spec.logDir,'exit.json'),bad);
  if(state==='absent')await docker(['rm',t.cid]);
  if(state==='present'){assert.equal((await unit.wait()).exitCode,0);assert.equal((await docker(['inspect',t.cid],true)).code,1);}else{await assert.rejects(unit.wait(),/Missing complete exit record.*容器恢复手册/);assert.equal(await exists(join(t.spec.logDir,'exit.json')),false);}
  const archived=(await readdir(t.spec.logDir)).filter(n=>n.startsWith('exit.json.damaged-')&&!n.endsWith('.recovery.json'));assert.equal(archived.length,1);assert.equal(await readFile(join(t.spec.logDir,archived[0]),'utf8'),bad);assert(await exists(join(t.spec.logDir,archived[0]+'.recovery.json')));console.log('PASS damaged exit preserved',state);
 }
 // Docker stop is idempotent for an already exited container (unlike the local socket).
 const t2=await toy('stop-exited');const result=await docker(['stop','--timeout=-1',t2.cid]);assert.equal(result.code,0);await (await fresh().adopt(runId,t2.spec.unitId))!.wait();console.log('PASS docker stop already exited returns zero');
}finally{for(const unitId of await fresh().list(runId)){const ids=(await docker(['ps','-aq','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+runId,'--filter','label=sec1.unit='+unitId])).stdout.trim().split(/\s+/).filter(Boolean);for(const id of ids){const info=JSON.parse((await docker(['inspect',id])).stdout)[0];assertOwned(info,runId,unitId);assert.equal(info.State.Running,false);await docker(['rm',info.Id]);}}}
