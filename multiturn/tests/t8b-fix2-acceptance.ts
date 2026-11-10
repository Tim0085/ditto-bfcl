import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,access,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {DockerLauncher} from '../src/ts/docker/launcher.ts';
import {acquireCollector} from '../src/ts/docker/collector-lock.ts';
import {docker,labels,save,assertOwned} from '../src/ts/docker/common.ts';
const evidence=resolve(process.env.T8B_FIX2_EVIDENCE??'runs/offline/t8b-fix2-20261105');
const root=await mkdtemp(join(tmpdir(),'t8b-fix2-probes-')),runId='t8b-fix2-'+process.pid;
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id,runtime={clockTicks:100,pageBytes:4096};
const fresh=()=>new DockerLauncher(imageId,runtime),minimal=process.argv.includes('--minimal');
const exists=(p:string)=>access(p).then(()=>true,()=>false);
async function until(test:()=>Promise<boolean>){const end=Date.now()+90000;while(!await test()){if(Date.now()>end)throw Error('Barrier timeout');await new Promise(r=>setTimeout(r,20));}}
async function toy(name:string,code=0){
 const dir=join(root,name),spec={runId,unitId:name,block:{runId,configId:name},outputRoot:dir,logDir:join(dir,'unit'),guardReportDir:join(dir,'guards'),egressUrl:'http://127.0.0.1:1'};
 await mkdir(spec.logDir,{recursive:true});await save(join(spec.logDir,'unit.json'),{spec,imageId,runtime,tag:'dev'});
 const cid=(await docker(['create','--pull=never',...labels(runId,name),'--label',`sec1.log-dir=${spec.logDir}`,'--network','none',imageId,'python3','-B','-c',`import os,time\nwhile not os.path.exists('/tmp/finish'):time.sleep(.02)\nos._exit(${code})`])).stdout.trim();
 await docker(['start',cid]);const input={root:dir,spec,imageId,runtime,cid};await save(join(dir,'input.json'),input);return input;
}
function child(t:any,mode:string,actor='child'){
 const args=['--import','./scripts/egress-offline-guard.mjs','--experimental-transform-types','tests/t8b-fix2-child.mjs',join(t.root,'input.json'),mode,actor];
 const p=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 const done=new Promise<number|null>((yes,no)=>{p.once('error',no);p.once('close',async code=>{await save(join(t.root,actor+'-process.json'),{command:[process.execPath,...args],pid:p.pid,code,stdout,stderr});yes(code);});});
 return {p,done};
}
async function finish(t:any){await writeFile(join(t.root,'finish'),'go');await docker(['cp',join(t.root,'finish'),t.cid+':/tmp/finish']);}
try{
 for(const mode of ['requested','dispatched','succeeded','no-request'])for(let i=0;i<(minimal?1:mode==='no-request'?1:3);i++){
  const t=await toy(mode+'-'+i,137);
  if(mode==='requested'||mode==='dispatched'){
   const c=child(t,mode);assert.equal(await c.done,mode==='requested'?71:72);
   const before=JSON.parse((await docker(['inspect',t.cid])).stdout)[0];await save(join(t.root,'after-launcher-crash.json'),before);
   if(mode==='requested')assert.equal(before.State.Running,true);
   if(before.State.Running)await finish(t);
  }else if(mode==='succeeded')await (await fresh().adopt(runId,t.spec.unitId))!.kill('confirmed delivery');else await finish(t);
  const launcher=fresh();assert((await launcher.list(runId)).includes(t.spec.unitId));const exit=await (await launcher.adopt(runId,t.spec.unitId))!.wait();
  const outcome=JSON.parse(await readFile(join(t.spec.logDir,'kill-outcome.json'),'utf8'));
  assert.equal(exit.exitCode,137);assert.equal(exit.killed,mode==='succeeded');assert.equal(exit.signal,mode==='succeeded'?'SIGKILL':null);
  assert.equal(outcome.outcome,({requested:'not-dispatched',dispatched:'unconfirmed',succeeded:'confirmed','no-request':'not-requested'} as any)[mode]);
  console.log(JSON.stringify({test:'M1',mode,iteration:i+1,exit,outcome}));
 }
 for(const mode of ['scheduled','natural'])for(let i=0;i<(minimal?1:mode==='scheduled'?5:10);i++){
  const t=await toy(mode+'-'+i),path=join(t.spec.logDir,'collector.lock');await save(path,{pid:2147483647,containerId:t.cid});
  const a=child(t,mode,'A'),b=child(t,mode,'B');
  try{
   await until(async()=>await exists(join(t.root,'A-ready'))&&await exists(join(t.root,'B-ready')));await writeFile(join(t.root,'go'),'go');
   if(mode==='scheduled'){
    await until(async()=>await exists(join(t.root,'A-read-stale'))&&await exists(join(t.root,'B-read-stale')));
    assert.equal(await readFile(join(t.root,'A-read-stale'),'utf8'),await readFile(join(t.root,'B-read-stale'),'utf8'));
    await writeFile(join(t.root,'release-A'),'go');await until(async()=>(await readFile(join(t.root,'A-docker.jsonl'),'utf8').catch(()=>'' )).includes('"wait"'));
    await writeFile(join(t.root,'release-B'),'go');
   }
   await until(async()=>await exists(join(t.root,'A-result.json'))||await exists(join(t.root,'B-result.json')));
   const loser=await exists(join(t.root,'A-result.json'))?'A':'B',rejected=JSON.parse(await readFile(join(t.root,loser+'-result.json'),'utf8'));
   assert.equal(rejected.ok,false);assert.match(rejected.error,/另一方正在收集这个单元/);assert.equal(await exists(join(t.root,loser+'-docker.jsonl')),false,'loser never collects or modifies container');
   await finish(t);assert.deepEqual(await Promise.all([a.done,b.done]),[0,0]);
   const results=await Promise.all(['A','B'].map(actor=>readFile(join(t.root,actor+'-result.json'),'utf8').then(JSON.parse)));
   assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>r.ok).exit.exitCode,0);
   assert.equal((await docker(['inspect',t.cid],true)).code,1);assert.equal(await exists(path),false);
   console.log(JSON.stringify({test:'M2',mode,iteration:i+1,results,loserUntouched:true,containerRemoved:true}));
  }finally{for(const c of [a,b])if(c.p.exitCode===null){c.p.kill();await c.done;}}
 }
 const dir=join(root,'token');await mkdir(dir);const release=await acquireCollector(dir,'a'.repeat(64)),path=join(dir,'collector.lock');
 const own=JSON.parse(await readFile(path,'utf8'));assert(own.token);
 const other={...own,token:'someone-else'};await save(path,other);await release();assert.deepEqual(JSON.parse(await readFile(path,'utf8')),other);
 assert.match(await readFile(join(dir,'collector-lock-events.jsonl'),'utf8'),/release-token-mismatch/);
 await mkdir(path+'.guard');await assert.rejects(acquireCollector(dir,'a'.repeat(64)),/另一方/);
 console.log('PASS: token mismatch preserved and recorded; abandoned guard fails closed');
 assert.deepEqual(await fresh().list(runId),[]);
}finally{
 // Only containers created under this process-specific run are eligible for cleanup.
 for(const unitId of await fresh().list(runId)){const ids=(await docker(['ps','-aq','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter',`label=sec1.run=${runId}`,'--filter',`label=sec1.unit=${unitId}`])).stdout.trim().split(/\s+/).filter(Boolean);for(const id of ids){const info=JSON.parse((await docker(['inspect',id])).stdout)[0];assertOwned(info,runId,unitId);if(info.State.Running)await docker(['kill',info.Id]);await docker(['rm',info.Id]);}}
 await cp(root,join(evidence,root.split(/[\\/]/).at(-1)!),{recursive:true});
}
