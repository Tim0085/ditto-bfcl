import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports,registerHooks} from 'node:module';
import {resourceSampler} from '../src/ts/resource-sampler.ts';
import {stamp} from '../src/ts/step-log.ts';
import {stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {json,read,lines,sleep,env,alive,digest} from '../src/ts/scheduler/io.ts';
import {killOwnedTree} from '../src/ts/scheduler/process-tree.ts';
import {exportRun,legacyResourceSampler} from '../src/ts/scheduler/export.ts';
import {consecutiveFailure} from '../src/ts/scheduler/records.ts';
import {inFlightWithRetry} from '../src/ts/scheduler/egress.ts';
import {mountPath,docker,dockerTimeoutMs,DockerTimeoutError} from '../src/ts/docker/common.ts';
import {DockerLauncher} from '../src/ts/docker/launcher.ts';
import {freezeLauncher} from '../src/ts/scheduler/launcher.ts';
import {imageContext} from '../src/ts/docker/image-context.ts';
import {scoreInContainer} from '../scripts/docker-score.ts';
import {DetailTable,jsonRows,jsonArray,fileEqual} from '../src/ts/scheduler/export-stream.ts';
const fresh=()=>fs.mkdtempSync(join(tmpdir(),'t8cf1-'));
const old=(name:string)=>import(pathToFileURL(resolve('before',name)).href);
const beforeAvailable=fs.existsSync('before/src/ts/resource-sampler.ts');
const imageId='sha256:'+'a'.repeat(64),runtime={clockTicks:100,pageBytes:4096};

function fakeDocker(answer:(args:string[])=>{code?:number;stdout?:string;stderr?:string}|null){
  const native=cp.spawn,commands:string[][]=[];
  cp.spawn=((file:any,args:any,options:any)=>{
    if(file!=='docker')throw Error('Unexpected command in fake Docker test: '+file);
    commands.push(args);const child:any=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
    const reply=answer(args);if(reply)queueMicrotask(()=>{child.stdout.end(reply.stdout??'');child.stderr.end(reply.stderr??'');child.emit('close',reply.code??0);});
    return child;
  }) as any;syncBuiltinESMExports();
  return {commands,restore(){cp.spawn=native;syncBuiltinESMExports();}};
}

test('D1 stop appends the final sample; availability and strict failure callback retain their meaning',async()=>{
  const results=[];
  for(const before of beforeAvailable?[true,false]:[false]){
    const dir=fresh(),cg=join(dir,'cg');fs.mkdirSync(cg);for(const [name,value] of Object.entries({'cpu.stat':'usage_usec 1000000','memory.current':'1000000000','cpu.max':'200000 100000','memory.max':'4294967296','memory.swap.max':'0','cgroup.procs':''}))fs.writeFileSync(join(cg,name),value);
    const errors:unknown[]=[],sample=before?(await old('src/ts/resource-sampler.ts')).resourceSampler:resourceSampler;
    const sampler=await sample(join(dir,'resources.jsonl'),{enabled:true,strict:true,intervalMs:60000,cgroupDirectory:cg,expected:{cpuMax:'200000 100000',memoryMax:'4294967296',swapMax:'0'}},()=>[],(e:unknown)=>errors.push(e));
    fs.writeFileSync(join(cg,'cpu.stat'),'usage_usec 2000000');const end=stamp();await sampler.stop();
    const rows=lines(join(dir,'resources.jsonl')).filter(r=>r.kind==='cgroup');
    if(before)assert.equal(rows.length,1);else{assert.equal(rows.length,2);assert(Date.parse(rows.at(-1).at.wall)>=Date.parse(end.wall));assert.equal(rows.at(-1).cpuUs,2000000);}
    assert.equal(errors.length,0);results.push({before,samples:rows.length,lastCpuUs:rows.at(-1).cpuUs});
  }
  console.log(JSON.stringify({D1:results}));
});

test('D1 export tolerates only one configured interval, marks the unobserved tail, and never extrapolates',async()=>{
  const root=fresh(),s=stage('resource-tail',['multi_turn_base_0']),p=freeze(s,root),j=p.jobs[0],cid='direct-c1',a=join(root,'blocks',j.blockId,cid,'r1/attempt-1'),dir=join(a,'output/configs',cid);
  json(join(a,'attempt.json'),{number:1,unitId:'synthetic',caseIds:j.caseIds});json(join(dir,'block.json'),{sampling:{intervalMs:200}});
  const wall=(n:number)=>new Date(1700000000000+n).toISOString();
  const rows=[0,300].map(n=>({kind:'cgroup',available:true,at:{wall:wall(n)},cpuUs:n*1000,rssBytes:1e9}));fs.writeFileSync(join(dir,'resources.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  json(join(dir,'block-summary.json'),{tasksStarted:{wall:wall(100),ns:'100000000'},tasksEnded:{wall:wall(350),ns:'350000000'},recordingFailures:{},workerRecordingFailures:{}});
  if(beforeAvailable){const b=(await old('src/ts/scheduler/export.ts')).exportRun(root,join(root,'before'));assert.equal(b.blockRows[0].cpuSeconds,null);}
  const x=exportRun(root,join(root,'after')),metric=x.blockRows[0].attempts[0];assert.equal(metric.cpuSeconds,.2);assert.equal(metric.gbSeconds,.2);assert(metric.missing.some((m:string)=>m.includes('tail gap 50ms')));
  json(join(dir,'block-summary.json'),{tasksStarted:{wall:wall(100),ns:'100000000'},tasksEnded:{wall:wall(501),ns:'501000000'},recordingFailures:{},workerRecordingFailures:{}});
  const beyond=exportRun(root,join(root,'beyond-limit')).blockRows[0];assert.equal(beyond.cpuSeconds,.2);assert.equal(beyond.resourceSamplingOk,false);assert(beyond.attempts[0].missing.some((m:string)=>m.includes('not fully covered; tail gap 201ms, allowed 200ms')));
  const {hash,...body}=p;body.fingerprints['src/ts/resource-sampler.ts']=legacyResourceSampler;json(join(root,'plan.json'),{...body,hash:digest(body)});
  const legacyExport=exportRun(root,join(root,'legacy-allowance')),legacy=legacyExport.blockRows[0].attempts[0];assert.equal(legacy.cpuSeconds,.2);assert.equal(legacy.resourceTailMs,201);assert.equal(legacy.resourceTailAllowanceMs,1000);assert(legacy.missing.some((m:string)=>m.includes('user-authorized legacy limit')));assert(legacyExport.summary[0].missing.some((m:string)=>m.includes('tail gap 201ms')));assert(legacyExport.blockRows[0].missing.some((m:string)=>m.includes('tail gap 201ms')));
  json(join(dir,'block-summary.json'),{tasksStarted:{wall:wall(100),ns:'100000000'},tasksEnded:{wall:wall(1301),ns:'1301000000'},recordingFailures:{},workerRecordingFailures:{}});const legacyBeyond=exportRun(root,join(root,'legacy-beyond-one-second')).blockRows[0];assert.equal(legacyBeyond.cpuSeconds,.2);assert.equal(legacyBeyond.resourceSamplingOk,false);assert(legacyBeyond.attempts[0].missing.some((m:string)=>m.includes('not fully covered; tail gap 1001ms, allowed 1000ms')));
  console.log(JSON.stringify({D1:{beforeNull:beforeAvailable,observedCpuSeconds:.2,observedGbSeconds:.2,tailMs:50,beyond200msRefused:true}}));
});

test('D1 a failed final sample remains unavailable and invokes the strict failure callback',async()=>{
  const dir=fresh(),cg=join(dir,'cg');fs.mkdirSync(cg);for(const [name,value] of Object.entries({'cpu.stat':'usage_usec 1','memory.current':'1','cpu.max':'200000 100000','memory.max':'4294967296','memory.swap.max':'0','cgroup.procs':''}))fs.writeFileSync(join(cg,name),value);
  const errors:unknown[]=[],sampler=await resourceSampler(join(dir,'r.jsonl'),{enabled:true,strict:true,intervalMs:60000,cgroupDirectory:cg,expected:{cpuMax:'200000 100000',memoryMax:'4294967296',swapMax:'0'}},()=>[],e=>errors.push(e));
  fs.writeFileSync(join(cg,'cpu.max'),'max 100000');await sampler.stop();
  assert.equal(errors.length,1);assert.equal(lines(join(dir,'r.jsonl')).filter(r=>r.kind==='cgroup').at(-1).available,false);assert(lines(join(dir,'r.jsonl')).some(r=>r.kind==='error'));
});

test('D5 skipped failure records preserve a streak even with no block summary',()=>{
  const a={path:fresh()},cid='c';json(join(a.path,'output/configs',cid,'failures/one.json'),{disposition:'skipped',streak:2});
  assert.equal(consecutiveFailure(a,cid,null)?.failures.length,1);
  json(join(a.path,'output/configs',cid,'failures/one.json'),{disposition:'interrupted',streak:2});assert.equal(consecutiveFailure(a,cid,null),null);
});

test('D6 freezing after an image input changes refuses the old content, with both fingerprints',async()=>{
  const before=beforeAvailable?(await old('src/ts/scheduler/launcher.ts')).freezeLauncher:null;
  const marker=resolve('scripts/docker-t8c-fix1-context-marker.txt');assert(!fs.existsSync(marker));
  const fingerprint=(await imageContext(resolve('.'))).fingerprint,info={Id:imageId,Config:{Labels:{'sec1.owner':'ditto-sec1-bfcl','sec1.complete':'true','sec1.context':fingerprint}}};
  const mock=fakeDocker(()=>({stdout:JSON.stringify([info])}));
  try{
    fs.writeFileSync(marker,'changed image input\n',{flag:'wx'});
    const s=stage('stale-image');s.launcher={kind:'docker',tag:'dev',runtime};
    if(before){await before(structuredClone(s));console.log('D6 before accepted an image built before a source input changed');}
    const actual=(await imageContext(resolve('.'))).fingerprint;assert.notEqual(actual,fingerprint);
    await assert.rejects(freezeLauncher(s),(e:any)=>String(e).includes(fingerprint)&&String(e).includes(actual));
    console.log(JSON.stringify({D6:{image:fingerprint,worktree:actual,oldImageRefused:true}}));
  }finally{mock.restore();fs.unlinkSync(marker);}
});

test('D8 finite inspect timeout is an error even with allowFailure; docker wait has no timeout',async()=>{
  assert.equal(dockerTimeoutMs(['inspect','id']),15000);assert.equal(dockerTimeoutMs(['wait','id']),0);
  const mock=fakeDocker(()=>null),native=setTimeout;let bounds:number[]=[];
  globalThis.setTimeout=((fn:any,ms:any,...args:any[])=>{if(ms===15000){bounds.push(ms);ms=25;}return native(fn,ms,...args);}) as any;
  try{
    await assert.rejects(docker(['inspect','never-returns'],true),DockerTimeoutError);assert.deepEqual(bounds,[15000]);
    if(beforeAvailable){let settled=false;void (await old('src/ts/docker/common.ts')).docker(['inspect','never-returns'],true).finally(()=>settled=true);await new Promise(r=>native(r,50));assert.equal(settled,false);}
    console.log(JSON.stringify({D8:{configuredTimeoutMs:15000,injectedTimerMs:25,timedOut:true,allowFailureStillThrows:true,beforeUnbounded:beforeAvailable}}));
  }finally{globalThis.setTimeout=native;mock.restore();}
});

test('D9 same runId in different roots ignores the foreign container without stop or kill',async()=>{
  const root=fresh(),foreign=fresh(),logDir=join(foreign,'logs'),runId='shared-run',unitId='foreign-unit';json(join(logDir,'unit.json'),{imageId,spec:{runId,unitId,logDir}});
  const id='b'.repeat(64),info={Id:id,Image:imageId,Config:{Labels:{'sec1.owner':'ditto-sec1-bfcl','sec1.run':runId,'sec1.unit':unitId,'sec1.log-dir':logDir}},State:{Running:true}};
  const mock=fakeDocker(args=>({stdout:args[0]==='ps'?id:JSON.stringify([info])}));
  try{
    if(beforeAvailable){const Old=(await old('src/ts/docker/launcher.ts')).DockerLauncher;assert(await new Old(imageId,runtime,'dev',root).adopt(runId,unitId));}
    assert.equal(await new DockerLauncher(imageId,runtime,'dev',root).adopt(runId,unitId),undefined);
    assert(await new DockerLauncher(imageId,runtime,'dev',foreign).adopt(runId,unitId));
    assert.equal(lines(join(root,'scheduler/events.jsonl'))[0].kind,'foreign-root-unit-ignored');assert(!mock.commands.some(a=>['kill','stop','rm'].includes(a[0])));
    console.log(JSON.stringify({D9:{beforeForeignAdopted:beforeAvailable,afterForeignIgnored:true,ownRootAdopted:true,noLifecycleCommands:true}}));
  }finally{mock.restore();}
});

test('D10 stop racing with a normal container exit is recorded as not-running',async()=>{
  const root=fresh(),runId='exit-race',unitId='u',logDir=join(root,'logs'),id='c'.repeat(64);json(join(logDir,'unit.json'),{imageId,spec:{runId,unitId,logDir}});
  const info={Id:id,Image:imageId,Config:{Labels:{'sec1.owner':'ditto-sec1-bfcl','sec1.run':runId,'sec1.unit':unitId,'sec1.log-dir':logDir}},State:{Running:true}};
  const mock=fakeDocker(args=>args[0]==='kill'?{code:1,stderr:'container is not running'}:{stdout:args[0]==='ps'?id:JSON.stringify([info])});
  try{
    if(beforeAvailable){const Old=(await old('src/ts/docker/launcher.ts')).DockerLauncher;const u=await new Old(imageId,runtime,'dev',root).adopt(runId,unitId);await assert.rejects(u.stop('old exit race'),/not running/);}
    const u=await new DockerLauncher(imageId,runtime,'dev',root).adopt(runId,unitId);await u!.stop('new exit race');assert.equal(read(join(logDir,'stop.json')).status,'not-running');
    console.log(JSON.stringify({D10:{beforeThrows:beforeAvailable,afterStatus:'not-running'}}));
  }finally{mock.restore();}
});

test('D11 heartbeat gaps retry before accepting fresh counters; a sustained gap never becomes zero',async()=>{
  const root=fresh(),path=join(root,'egress/status.json');json(path,{at:Date.now()-6000,active:{c:2}});
  if(beforeAvailable){const previous=await old('src/ts/scheduler/egress.ts');assert.throws(()=>previous.inFlight(root,'c'),/stale/);}
  const native=fs.readFileSync;let calls=0;
  fs.readFileSync=((p:any,...args:any[])=>{if(String(p)===path&&++calls===2)json(path,{at:Date.now(),active:{c:2}});return (native as any)(p,...args);}) as any;syncBuiltinESMExports();
  try{assert.equal(await inFlightWithRetry(root,'c'),2);assert.equal(calls,2);}finally{fs.readFileSync=native;syncBuiltinESMExports();}
  json(path,{at:Date.now()-6000,active:{c:2}});await assert.rejects(inFlightWithRetry(root,'c'),/stale/);
  console.log(JSON.stringify({D11:{transientReads:calls,transientRecovered:true,persistentRejected:true}}));
});
test('R2 sixteen mount levels pass, seventeen are rejected before Docker create',async()=>{
  const path=(n:number)=>'F:/'+Array.from({length:n},(_,i)=>'d'+i).join('/');assert.equal(mountPath(path(16)),path(16));assert.throws(()=>mountPath(path(17)),/17 levels.*maximum 16/);
  const mock=fakeDocker(()=>{throw Error('Docker must not be reached');});try{await assert.rejects(scoreInContainer(imageId,path(17)+'/input.json',fresh()+'/out.json',fresh()),/17 levels/);assert.equal(mock.commands.length,0);}finally{mock.restore();}
});

test('Interruption final observation runs after process inventories and rejects before any owned PID is killed',async()=>{
  const root=fresh(),child=cp.spawn(process.execPath,['--import','./scripts/egress-offline-guard.mjs','-e','process.stdout.write("ready");setInterval(()=>{},1000)'],{windowsHide:true,env:env(join(root,'guards')),stdio:['ignore','pipe','pipe']});
  const done=new Promise(r=>child.once('close',r));await new Promise<void>((yes,no)=>{child.stdout.once('data',()=>yes());child.once('error',no);});
  const authenticatedAt=new Date().toISOString();let checked=0;
  try{
    await assert.rejects(killOwnedTree(child.pid!,join(root,'process-guard'),authenticatedAt,()=>{checked++;throw Error('Final heartbeat changed');}),/Final heartbeat changed/);
    assert(alive(child.pid!));assert.equal(checked,1);
    const killed=await killOwnedTree(child.pid!,join(root,'process-guard'),authenticatedAt,()=>{checked++;});assert(killed.includes(child.pid!));await done;assert.equal(checked,2);
    console.log(JSON.stringify({finalObservationBeforeKill:true,refusedObservationKeptProcessAlive:true,authorizedOwnChildKilled:true}));
  }finally{if(alive(child.pid!)){child.kill('SIGKILL');await done;}}
});

test('Builder cleanup --run discovers only the matching owned builder as well as normal run labels',async()=>{
  const root=fresh(),ledger=join(root,'ledger.json'),workspace=process.cwd();json(ledger,[]);fs.mkdirSync(join(root,'runs'));const id='d'.repeat(64),builder='isolated-builder';
  const info={Id:id,Config:{Labels:{'sec1.owner':'ditto-sec1-bfcl','sec1.builder':builder}},State:{Running:false}};
  const saved=process.argv;
  for(const before of beforeAvailable?[true,false]:[false]){
    const mock=fakeDocker(args=>({stdout:args[0]==='ps'?args.includes('label=sec1.builder='+builder)?id:'':args[0]==='inspect'?JSON.stringify([info]):''}));
    try{
      process.argv=[process.execPath,'scripts/docker-gc.ts','--run='+builder,'--ledger='+ledger];
      process.chdir(root);await import(pathToFileURL(join(workspace,before?'before/scripts/docker-gc.ts':'scripts/docker-gc.ts')).href+'?builder-probe='+Date.now());
      assert.equal(mock.commands.some(a=>a[0]==='inspect'&&a[1]===id),!before);assert(!mock.commands.some(a=>a[0]==='rm'));
      console.log(JSON.stringify({before,builderDiscovered:!before,dryRunOnly:true,queries:mock.commands.filter(a=>a[0]==='ps')}));
    }finally{mock.restore();process.argv=saved;process.chdir(workspace);}
  }
});

test('Local build archive timeout leaves no fake build containers and never commits a partial image',async()=>{
  let created=0;const ids:string[]=[],native=setTimeout,prior=process.env.SEC1_DOCKER_SCRATCH;
  process.env.SEC1_DOCKER_SCRATCH='F:/Academic/Ditto/experiments/sec1/_tmp/scratch/t8c-fix1';
  const mock=fakeDocker(args=>{
    if(args[0]==='cp')return null;
    if(args[0]==='image'&&args[1]==='inspect')return {stdout:JSON.stringify([{Id:imageId}])};
    if(args[0]==='create'){const id=(++created===1?'e':'f').repeat(64);ids.push(id);return {stdout:id};}
    if(args[0]==='inspect')return {stdout:JSON.stringify([{Id:args[1],Config:{Labels:{'sec1.owner':'ditto-sec1-bfcl'}},State:{Running:false}}])};
    return {stdout:''};
  });
  let bounded=0;globalThis.setTimeout=((fn:any,ms:any,...args:any[])=>{if(ms===120000){bounded++;ms=25;}return native(fn,ms,...args);}) as any;
  try{
    await assert.rejects(import(pathToFileURL(resolve('scripts/docker-build.ts')).href+'?archive-timeout='+Date.now()),/archive copy timed out after 120000ms/);
    assert.equal(bounded,1);assert.equal(created,2);assert.deepEqual(mock.commands.filter(a=>a[0]==='rm').map(a=>a[1]).sort(),ids.sort());assert(!mock.commands.some(a=>a[0]==='commit'));
    console.log(JSON.stringify({configuredArchiveTimeoutMs:120000,fakeBuildContainersRemoved:2,noCommitOnTimeout:true,realDockerCalls:0}));
  }finally{globalThis.setTimeout=native;mock.restore();if(prior===undefined)delete process.env.SEC1_DOCKER_SCRATCH;else process.env.SEC1_DOCKER_SCRATCH=prior;}
});

test('Streaming rows preserve Unicode boundaries, malformed diagnostics, JSON-array bytes and exclusive publication',()=>{
  const root=fresh(),rows=[{text:'界🙂'.repeat(30000),n:1},{n:2,missing:[]},{}],writer=new DetailTable(join(root,'rows.jsonl'));
  for(const row of rows)writer.push(row);const info=writer.finish();assert.deepEqual([...jsonRows(join(root,'rows.jsonl'))],rows);assert.equal(info.utf8Bytes,fs.statSync(join(root,'rows.jsonl')).size);assert.equal(info.utf16CodeUnits,fs.readFileSync(join(root,'rows.jsonl'),'utf8').length);
  jsonArray(join(root,'a.json'),rows);fs.writeFileSync(join(root,'b.json'),JSON.stringify(rows,null,2)+'\n');assert(fileEqual(join(root,'a.json'),join(root,'b.json')));
  const collision=new DetailTable(join(root,'a.json'));collision.push({changed:true});assert.throws(()=>collision.finish(),/EEXIST/);assert(fileEqual(join(root,'a.json'),join(root,'b.json')));
  fs.writeFileSync(join(root,'bad.jsonl'),'{}\n\n{broken\n{}');const malformed=[...jsonRows(join(root,'bad.jsonl'))];assert.equal(malformed.length,3);assert.equal(malformed[1].malformed,true);assert.throws(()=>[...jsonRows(join(root,'bad.jsonl'),true)],/Invalid JSONL/);
});

test('R2 freezing rejects a too-deep /unit before writing a plan; old freeze allowed it',async()=>{
  const root=resolve('F:/Academic/Ditto/experiments/sec1/_tmp/scratch/t8c-fix1/depth/'+Date.now()+'/a/b'),s=stage('deep-freeze');s.launcher={kind:'docker',tag:'dev',imageId,runtime};
  if(beforeAvailable){const module=await old('src/ts/scheduler/plan.ts');module.freeze(s,root);assert(fs.existsSync(join(root,'plan.json')));}
  const original=fs.existsSync(join(root,'plan.json'))?fs.readFileSync(join(root,'plan.json')):null;
  assert.throws(()=>freeze(s,root),/Cannot freeze.*mount \/unit:.*17 levels/s);
  if(original)assert(original.equals(fs.readFileSync(join(root,'plan.json'))));else assert(!fs.existsSync(join(root,'plan.json')));
});

test('Streaming export never attributes an unidentified request to a task that has not started',()=>{
  const root=fresh();freeze(stage('unidentified-request',['multi_turn_base_0']),root);
  const requests=new DetailTable(join(root,'egress/requests.jsonl'));requests.push({configId:'direct-c1',requestBody:{message:'unknown'}});requests.finish();
  const row=exportRun(root,join(root,'export')).taskRows[0];assert.equal(row.state,'not-started');assert.equal(row.requestBodyBytes,null);assert(row.missing.includes('requestBodyBytes: request records unavailable'));
});

test('Unavailable cgroup records without timestamps remain null diagnostics instead of aborting export',()=>{
  const root=fresh(),p=freeze(stage('unavailable-resource',['multi_turn_base_0']),root),j=p.jobs[0],a=join(root,'blocks',j.blockId,'direct-c1/r1/attempt-1'),dir=join(a,'output/configs/direct-c1');
  json(join(a,'attempt.json'),{number:1,unitId:'synthetic',caseIds:j.caseIds});
  json(join(dir,'block-summary.json'),{tasksStarted:{wall:'2023-11-14T22:13:20.000Z',ns:'1000000000'},tasksEnded:{wall:'2023-11-14T22:13:21.000Z',ns:'2000000000'}});
  const writer=new DetailTable(join(dir,'resources.jsonl'));for(let i=0;i<2;i++)writer.push({kind:'cgroup',available:false,reason:'read failed'});writer.finish();
  const row=exportRun(root,join(root,'export')).blockRows[0];assert.equal(row.cpuSeconds,null);assert.equal(row.gbSeconds,null);assert(row.missing.some((m:string)=>m.includes('cgroup samples incomplete')));
});

test('R2 future mount paths are projected through junction targets before freeze',()=>{
  if(process.platform!=='win32')return;
  const root=fresh(),alias=join(root,'alias'),target=join(root,...Array.from({length:17},(_,i)=>'d'+i));fs.mkdirSync(target,{recursive:true});fs.symlinkSync(target,alias,'junction');
  try{assert.throws(()=>mountPath(join(alias,'future','output')),/levels.*maximum 16/);assert(fs.existsSync(target));}
  finally{
    const command="[System.IO.Directory]::Delete('"+alias.replaceAll("'","''")+"',$false)";
    cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,env:env(join(root,'guards'))});
    assert(!fs.existsSync(alias));assert(fs.existsSync(target));console.log(JSON.stringify({removedOwnJunction:alias,target,targetPreserved:true}));
  }
});

test('Builder cleanup never treats inherited builder labels on run units as construction ownership',async()=>{
  const workspace=process.cwd(),root=fresh(),ledger=join(root,'ledger.json'),target='own-builder',saved=process.argv;
  fs.mkdirSync(join(root,'runs'));json(ledger,[]);
  const labels=(more:any)=>({'sec1.owner':'ditto-sec1-bfcl','sec1.builder':target,...more});
  const infos=[{'sec1.run':'foreign-run','sec1.unit':'foreign-unit'},{'sec1.run':'','sec1.unit':''},{},{'sec1.run':target,'sec1.unit':'own-unit'}].map((extra,i)=>({Id:String.fromCharCode(97+i).repeat(64),Config:{Labels:labels(extra)},State:{Running:false}}));
  const snapshot=fs.readFileSync(join(workspace,'tests/t8c-fix1-fixtures/gc-before.ts.txt'),'utf8');
  for(const before of [true,false]){
    const url=pathToFileURL(join(workspace,'scripts/docker-gc.ts')).href+'?inherited-builder='+before+'-'+Date.now();
    const hook=before?registerHooks({load(path,context,next){return path===url?{format:'module-typescript',source:snapshot,shortCircuit:true}:next(path,context);}}):null;
    const mock=fakeDocker(args=>({stdout:args[0]==='ps'?(args.includes('label=sec1.builder='+target)?infos.slice(0,3).map(i=>i.Id):[infos[3].Id]).join('\n'):args[0]==='inspect'?JSON.stringify([infos.find(i=>i.Id===args[1])]):''}));
    try{
      process.chdir(root);process.argv=[process.execPath,'scripts/docker-gc.ts','--run='+target,'--ledger='+ledger,'--apply'];await import(url);
      const removed=mock.commands.filter(a=>a[0]==='rm').map(a=>a[1]).sort();assert.deepEqual(removed,(before?infos:infos.slice(2)).map(i=>i.Id).sort());
      console.log(JSON.stringify({before,removed,foreignAndEmptyRunLabelsPreserved:!before,genuineBuilderAndExplicitOwnRunRemoved:true,realDockerCalls:0}));
    }finally{mock.restore();hook?.deregister();process.argv=saved;process.chdir(workspace);}
  }
});
