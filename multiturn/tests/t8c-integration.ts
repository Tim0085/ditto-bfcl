import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {stage,comparisonView,command,referenceRoot} from './t8a-helpers.ts';
import {freeze,matrix,categories} from '../src/ts/scheduler/plan.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {attempts,merged,remaining} from '../src/ts/scheduler/records.ts';
import {read,json,lines,files,sleep,env,ROOT,alive} from '../src/ts/scheduler/io.ts';
import {docker} from '../src/ts/docker/common.ts';
import {launcherFor} from '../src/ts/scheduler/launcher.ts';
import {connect} from '../src/ts/scheduler/control.ts';
import {recoverEgress,closeEgress,inFlight,interruptHungEgress} from '../src/ts/scheduler/egress.ts';
const root=resolve(process.argv[2]),scenario=process.argv[3]??'smoke';mkdirSync(root,{recursive:true});
const permanentFreeze=process.argv.includes('--permanent-freeze'),noSummary=process.argv.includes('--no-summary'),inspectHang=process.argv.includes('--inspect-hang');
const tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev';
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id;
const s=stage('t8c-'+scenario),runtime={clockTicks:100,pageBytes:4096};
s.launcher={kind:'docker',tag,imageId,runtime};s.sampling.strict=true;s.stall={idleMs:120000,stopGraceMs:5000,pollMs:200};s.hostSampleMs=1000;
if(['smoke','blip','tasks-fail','never-started','hung-flight'].includes(scenario))s.batches[0].caseIds=['multi_turn_base_0'];
if(scenario==='streak'){s.configs=[matrix().find(c=>c.id==='direct-c1')!,{...matrix().find(c=>c.id==='mono-1-c1')!,id:'peer'}];s.batches[0].configs=s.configs.map(c=>c.id);s.batches[0].caseIds=['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_base_12','multi_turn_base_13'];s.blockSize=3;}
if(scenario==='stop-all'){s.configs=[matrix().find(c=>c.id==='direct-c1')!,{...matrix().find(c=>c.id==='direct-c1')!,id:'peer'}];s.batches[0].configs=s.configs.map(c=>c.id);s.stall={idleMs:15000,stopGraceMs:1000,pollMs:100};}
if(scenario==='hung-flight'){s.stall={idleMs:15000,stopGraceMs:500,pollMs:50};s.egress.settings.model.timeoutMs=300;s.egress.retryPolicy.maxRetries=0;s.egress.dispatchPolicy.maxCooldownMs=1;}
if(noSummary){assert.equal(scenario,'streak');s.stall={idleMs:15000,stopGraceMs:500,pollMs:100};}
const plan=freeze(s,root),job=plan.jobs[0],disabled=join(root,'disabled'),entered=join(root,'entered'),release=join(root,'release');
async function until(predicate:()=>boolean|Promise<boolean>,message:string,limit=180000){for(const end=Date.now()+limit;;){if(await predicate())return;if(Date.now()>end)throw Error('Timed out: '+message);await sleep(100);}}
function launch(options:any,label:string){const path=join(root,label+'-options.json');json(path,options,true);const args=['--experimental-transform-types','tests/t8c-runner.ts',root,path];
  const child=spawn(process.execPath,args,{cwd:ROOT,env:env(join(root,'guards',label)),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const done=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',code=>{json(join(root,label+'-process.json'),{command:['node',...args],pid:child.pid,code,stdout,stderr},true);yes(code);});});return {child,done};
}
const options:any={egress:{delayMs:100,disabled}};
if(scenario==='hung-flight')options.requestBarrier=entered;
if(inspectHang){assert.equal(scenario,'hung-flight');options.inspectHang=true;}
if(scenario==='unit-kill')options.unitFault={skip:true,caseId:job.units[0].caseIds[0]};
if(scenario==='streak')options.unitFault={skip:true,configId:'direct-c1'};
if(noSummary)options.unitFault.summaryHang=true;
if(scenario==='stop-all')options.unitFault={hang:true};
if(scenario==='tasks-fail')options.unitFault={tasksFail:true};
if(scenario==='never-started')options.neverStarted=true;
if(scenario==='egress-stop')options.egress={stop:true,disabled};
if(['egress-crash','hung-flight'].includes(scenario))options.egress={entered,release,disabled};
if(scenario==='egress-hang')options.egress={entered,blockHeartbeatMs:15000,disabled};
if(permanentFreeze){assert.equal(scenario,'egress-hang');options.egress={entered,blockHeartbeatForever:true,disabled};}
if(scenario==='blip')options.blip=true;
if(scenario==='lost-stop-reply')options.lostStopReply=true;
const first=launch(options,'first'),launcher=launcherFor(root,plan);
if(['planned','lost-stop-reply','unit-kill','restart','egress-crash'].includes(scenario)){
  await until(()=>existsSync(join(root,'egress','status.json'))&&inFlight(root,'direct-c1')>0,'first in-flight request');
  if(['planned','lost-stop-reply'].includes(scenario))await connect(join(root,'scheduler'),true);
  if(scenario==='unit-kill'){const ids=await launcher.list(s.runId);assert.equal(ids.length,1);await (await launcher.adopt(s.runId,ids[0]))!.kill('authorized offline fault injection');}
  if(scenario==='egress-crash'){await until(()=>existsSync(entered),'held request');const pid=read(join(root,'scheduler','egress','control.json')).pid;assert(alive(pid));process.kill(pid,'SIGKILL');writeFileSync(release,'release later attempts');}
  if(scenario==='restart'){
    const ids=await launcher.list(s.runId),awake=read(join(root,'scheduler','awake.json'));assert.equal(ids.length,1);const killedAt=Date.now();first.child.kill('SIGKILL');await first.done;
    await until(()=>!alive(awake.pid),'sleep helper leaves after parent death',5000);json(join(root,'awake-parent-death.json'),{parentPid:first.child.pid,helperPid:awake.pid,afterMs:Date.now()-killedAt,finiteExit:true},true);
    assert(await (await launcher.adopt(s.runId,ids[0]))!.isAlive());
    const resumed=launch(options,'adopted');await until(()=>lines(join(root,'scheduler','events.jsonl')).some(e=>e.kind==='adopt'),'new scheduler adoption');
    assert.deepEqual(await launcher.list(s.runId),ids);await connect(join(root,'scheduler'),true);assert.equal(await resumed.done,0,read(join(root,'adopted-process.json')).stderr);
    json(join(root,'restart-proof.json'),{sameUnitIds:ids,noDuplicateStart:true,plannedStopAfterAdoption:true},true);
  }
}
if(scenario!=='restart'){
  const code=await first.done;
  if(scenario==='egress-hang'||inspectHang)assert.notEqual(code,0);else assert.equal(code,0,read(join(root,'first-process.json')).stderr);
}
const report=read(join(root,'scheduler','stop-report.json'));json(join(root,'initial-report.json'),report,true);
if(['smoke','blip'].includes(scenario))assert.equal(report.status,'complete',JSON.stringify(report));
else assert.equal(report.status,'paused',JSON.stringify(report));
const before=exportRun(root,join(root,'export-before'));
if(scenario==='lost-stop-reply'){
  const a=attempts(root,job,'direct-c1')[0],signal=lines(join(a.path,'logs','signals.jsonl'))[0],exit=read(join(a.path,'collected.json')),elapsed=Date.parse(exit.endedAt)-signal.at*1000;
  assert(elapsed>=0&&elapsed<5000,'real container must exit within the five-second grace after SIGTERM');assert(report.launcherErrors.some((r:any)=>r.operation==='stop'));assert.notEqual(report.reason,'scheduler-error');
  json(join(root,'lost-stop-reply-proof.json'),{elapsedMs:elapsed,graceMs:5000,signal,exit,launcherErrors:report.launcherErrors},true);
}
if(scenario==='blip'){
  const raw=files(join(root,'blocks')).filter(p=>p.endsWith('steps.jsonl')&&!p.includes('workers')).flatMap(p=>lines(p)).filter(r=>r.node==='INFER.REASONING.SAMPLE');
  assert(raw.some(r=>r.connectRetries===3));assert(read(join(root,'blip-up.json')).at-read(join(root,'blip-down.json')).at>=3950);
}
if(scenario==='unit-kill'){assert.equal(before.summary[0].goodput,null);assert.equal(before.summary[0].completionRate,null);assert(before.taskRows.some(r=>r.state==='skipped'));assert(report.terminations.some((r:any)=>r.outcome==='confirmed'));}
if(['tasks-fail','never-started'].includes(scenario)){assert.equal(report.reason,'configuration-not-started');assert.equal(lines(join(root,'egress','ledger.jsonl')).filter(r=>r.kind==='reserve').length,0);}
if(scenario==='stop-all'){
  const events=lines(join(root,'scheduler','events.jsonl')),dispatch=events.filter(e=>e.kind==='stop-dispatch'),kills=events.filter(e=>e.kind==='force-kill');
  assert.equal(new Set(dispatch.map(e=>e.unitId)).size,2);assert.equal(kills.length,2);assert(Date.parse(dispatch[1].at)-Date.parse(dispatch[0].at)<1000,'SIGTERM sent to both before waiting');
}
if(scenario==='streak'){
  assert.equal(report.reason,noSummary?'stall':'consecutive-failure');assert.equal(merged(root,job,'peer').size,3);assert.equal(attempts(root,plan.jobs[1],'peer').length,0);
  if(noSummary){const a=attempts(root,job,'direct-c1')[0];assert(!existsSync(join(a.path,'output/configs/direct-c1/block-summary.json')));assert(lines(join(root,'scheduler/events.jsonl')).some(e=>e.kind==='force-kill'&&e.unitId===a.unitId));assert(files(join(a.path,'output/configs/direct-c1/failures')).some(p=>read(p).streak>=2));const pauses=files(join(root,'scheduler/failure-pauses')).map(p=>read(p));assert(pauses.some(p=>p.reason==='consecutive-failure'&&p.details.summary===null&&p.details.failures.some((f:any)=>f.record.disposition==='skipped'&&f.record.streak>=2)&&report.pauseIds.includes(p.pauseId)));}
  const refused=launch(options,'refused');assert.notEqual(await refused.done,0);assert.match(read(join(root,'refused-process.json')).stderr,/needs user authorization/);
}
if(scenario==='hung-flight'){
  assert.equal(report.reason,inspectHang?'unit-launcher-error':'stall');assert.equal(report.egressLeftRunning,true);assert.equal(report.stuckUnits.length,1);assert.equal(inFlight(root),1);
  if(inspectHang){assert(report.launcherErrors.some((e:any)=>e.operation==='isAlive'&&e.error.includes('timed out')));const injected=read(join(root,'docker-inspect-hung.json'));assert(!alive(injected.pid));}
  assert(!lines(join(root,'scheduler','events.jsonl')).some(e=>e.kind==='force-kill'));
  await assert.rejects(interruptHungEgress(root,''),/authorization/);
  await interruptHungEgress(root,'Authorized offline acceptance: confirmed hung request; preserve all unknown liabilities');
  writeFileSync(release,'released for later requests');
  await until(async()=>{for(const id of await launcher.list(s.runId))if(await (await launcher.adopt(s.runId,id))!.isAlive())return false;return true;},'units notice interrupted egress');
}
if(scenario==='egress-hang'){
  assert.match(report.error,/stale/);assert(!lines(join(root,'scheduler','events.jsonl')).some(e=>/kill/.test(e.kind)));
  if(permanentFreeze){assert.equal(report.egressLeftRunning,true);assert(report.stuckUnits.length>0);const receipt=await interruptHungEgress(root,'Authorized offline acceptance: event loop frozen permanently; end only owned egress, preserve unknown fees');assert.equal(read(receipt.receipt).frozen,true);}
  await until(async()=>{for(const id of await launcher.list(s.runId))if(await (await launcher.adopt(s.runId,id))!.isAlive())return false;return true;},'units drain after heartbeat recovers');
  await closeEgress(root);
}
const permanent=new Map(plan.jobs.flatMap(j=>j.units.flatMap(u=>[...merged(root,j,u.configId)].filter(([,r])=>r.kind==='tasks'||r.data.disposition==='skipped').map(([id,r])=>[j.key+'/'+u.configId+'/'+id,r.attempt] as const))));
writeFileSync(disabled,'disabled');
if(!['smoke','blip'].includes(scenario)){
  if(existsSync(join(root,'egress','stopped.json'))||['egress-crash','hung-flight'].includes(scenario)||permanentFreeze){
    await assert.rejects(recoverEgress(root,''),/authorization/);await sleep(5200);
    const ledger=readFileSync(join(root,'egress','ledger.jsonl')),rec=await recoverEgress(root,'Authorized offline recovery; keep unknown fees');
    assert(readFileSync(join(root,'egress','ledger.jsonl')).subarray(0,ledger.length).equals(ledger));assert.equal(rec.before.reservedMicroUsd+rec.before.retainedMicroUsd,rec.after.reservedMicroUsd+rec.after.retainedMicroUsd);
    json(join(root,'recovery-proof.json'),rec,true);
  }
  const pauses=files(join(root,'scheduler','failure-pauses')).filter(p=>p.endsWith('.json')).map(p=>read(p).pauseId),authorization=pauses.map(id=>'pause:'+id).join(' ')+' Authorized offline resume';
  const next=launch({...options,egress:{delayMs:10,disabled},authorization},'resume-1');assert.equal(await next.done,0,read(join(root,'resume-1-process.json')).stderr);
  if(['egress-hang','hung-flight'].includes(scenario)){assert.equal(read(join(root,'scheduler','stop-report.json')).reason,'unit-failure');const second=launch({...options,egress:{delayMs:10,disabled},authorization},'resume-2');assert.equal(await second.done,0,read(join(root,'resume-2-process.json')).stderr);}
  assert.equal(read(join(root,'scheduler','stop-report.json')).status,'complete');
}
for(const j of plan.jobs)for(const u of j.units){assert.equal(remaining(root,j,u.configId).length,0);for(const [id,r] of merged(root,j,u.configId)){const key=j.key+'/'+u.configId+'/'+id;if(permanent.has(key))assert.equal(r.attempt,permanent.get(key));}}
const result=exportRun(root,join(root,'export-1'));exportRun(root,join(root,'export-2'));for(const p of files(join(root,'export-1')))assert(readFileSync(p).equals(readFileSync(p.replace('export-1','export-2'))));
assert(result.taskRows.every(r=>r.state==='skipped'||r.state==='completed'&&r.scoreStatus==='scored'));
if(scenario==='unit-kill'){assert(result.summary[0].goodput!==null);assert(result.summary[0].completionRate!==null);}
assert.deepEqual(await launcher.list(s.runId),[]);
const survivors=plan.jobs.flatMap(j=>j.caseIds.filter(id=>j.units.every(u=>merged(root,j,u.configId).get(id)?.kind==='tasks')));
if(survivors.length){comparisonView(root,join(root,'compare-input'));json(join(root,'cases.json'),survivors,true);const comp=await command(s.python,['-B','-X','utf8','scripts/compare.py','--new-run',join(root,'compare-input'),'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(root,'cases.json'),'--output',join(root,'comparison')],join(root,'comparison-process'));assert.equal(comp.code,0,comp.stdout+comp.stderr);}
json(join(root,'verification.json'),{scenario,permanentFreeze,noSummary,inspectHang,imageId,status:'PASS',initialReport:report,finalTasks:result.taskRows.length,permanentNotRerun:true,doubleExportByteIdentical:true,ownerContainers:0},true);
console.log(JSON.stringify({scenario,status:'PASS',imageId,finalTasks:result.taskRows.length}));
