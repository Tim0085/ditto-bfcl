// T9 segment A acceptance 4: pause combinations in real containers, moments pinned by release files.
// Lanes: [direct-c1] | [direct-c4, mono-4-c4] then [direct-c8, mono-8-c8]; 2 blocks of 4 tasks.
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {stage,comparisonView,command,referenceRoot} from './t8a-helpers.ts';
import {launch,until,groupStarted,unitExited,events,windows,release} from './t9-helpers.ts';
import {matrix,freeze} from '../src/ts/scheduler/plan.ts';
import {attempts,merged,remaining} from '../src/ts/scheduler/records.ts';
import {read,json,files,sleep} from '../src/ts/scheduler/io.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {docker} from '../src/ts/docker/common.ts';
import {launcherFor} from '../src/ts/scheduler/launcher.ts';
import {connect} from '../src/ts/scheduler/control.ts';
import {recoverEgress,inFlight} from '../src/ts/scheduler/egress.ts';
const root=resolve(process.argv[2]),mode=process.argv[3];assert(['streak','egress-stop','planned'].includes(mode));mkdirSync(root,{recursive:true});
const tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev',imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id;
const c1=['direct-c1'],c4=['direct-c4','mono-4-c4'],c8=['direct-c8','mono-8-c8'],all=[...c1,...c4,...c8];
const s=stage('t9-pause-'+mode,['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_miss_param_0','multi_turn_miss_param_4','multi_turn_miss_param_10','multi_turn_miss_param_36']);
s.configs=all.map(id=>matrix().find(c=>c.id===id)!);s.batches[0].configs=all;s.batches[0].lanes=[[c1],[c4,c8]];s.blockSize=4;s.launcher={kind:'docker',imageId,tag,runtime:{clockTicks:100,pageBytes:4096}};s.sampling.strict=true;s.stall={idleMs:120000,stopGraceMs:5000,pollMs:200};s.hostSampleMs=1000;
const runRoot=join(root,'run'),plan=freeze(s,runRoot),job=plan.jobs[0],next=plan.jobs[1],barriers=join(root,'barriers');mkdirSync(barriers,{recursive:true});
const disabled=join(runRoot,'disabled'),armed=join(barriers,'stop-armed'),key=(cid:string,caseId:string)=>`${cid}/${caseId}`,holdMap:Record<string,string>={};
// Only the first block is held. c4 in planned mode lets its first two cases finish.
for(const unit of job.units){const tier=s.configs.find(c=>c.id===unit.configId)!.c;unit.caseIds.forEach((caseId,i)=>{if(tier===4&&mode==='planned'&&i<2)return;holdMap[key(unit.configId,caseId)]=release(barriers,'c'+tier);});}
const holds=join(barriers,'holds.json');json(holds,holdMap,true);
const open=(tier:string)=>writeFileSync(release(barriers,tier),'release');
const count=async()=>(await docker(['ps','-q','--no-trunc','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+s.runId])).stdout.trim().split(/\s+/).filter(Boolean).length;
const stopConfig=mode==='egress-stop'?{stopConfig:'mono-4-c4',stopArmed:armed}:{};
const options:any={egress:{holds,disabled,...stopConfig},...(mode==='streak'?{unitFault:{skip:true,configId:'direct-c4'}}:{})};
const first=launch(root,runRoot,options,'first'),launcher=launcherFor(runRoot,plan),proof:any={mode};
const alive=()=>assert.equal(first.child.exitCode,null,'scheduler left early');
await until(()=>{alive();return groupStarted(runRoot,job.key,2,1);},'c4 group start');
if(mode==='streak'){
 // direct-c4 fails before any request; mono-4-c4 is still held, so "the rest of c4" really is unfinished.
 await until(()=>{alive();return unitExited(runRoot,job.key,'direct-c4');},'direct-c4 stops after two failures');
 const a=attempts(runRoot,job,'direct-c4')[0],streak=files(join(a.path,'output/configs/direct-c4/failures')).map(p=>read(p)).filter(r=>r.disposition==='skipped').map(r=>r.streak);assert(Math.max(...streak)>=2,JSON.stringify(streak));
 assert(files(join(runRoot,'scheduler/failure-pauses')).length>=1,'pause is durable before the group ends');assert(!groupStarted(runRoot,job.key,2,2),'c8 waits for the rest of c4');assert.equal(await count(),2,'c1 unit and mono-4-c4 are still running');
 proof.heldAtPause={stillRunning:2,streak};
 open('c4');
 await until(()=>{alive();return groupStarted(runRoot,job.key,2,2);},'c8 group starts after the pause was recorded');
 await until(async()=>{alive();return await count()===3;},'c8 units beside c1');open('c8');open('c1');
}
if(mode==='egress-stop'){
 await until(async()=>{alive();return await count()===3&&inFlight(runRoot,'mono-4-c4')>0;},'c4 units up, mono-4-c4 request held');
 writeFileSync(armed,'stop now');open('c4');
 await until(()=>{alive();return existsSync(join(runRoot,'egress/stopped.json'));},'egress stopped');open('c1');
}
if(mode==='planned'){
 const finished=(cid:string)=>{const a=attempts(runRoot,job,cid)[0];return a?files(join(a.path,'output/configs',cid,'tasks')).filter(p=>p.endsWith('.json')).length:0;};
 await until(()=>{alive();return c4.every(c=>finished(c)===2&&inFlight(runRoot,c)>0);},'two tasks done and two in flight for each c4 config');
 await connect(join(runRoot,'scheduler'),true);
 await until(()=>{alive();return events(runRoot).filter(e=>e.kind==='planned-stop').length===3;},'stop reached all three running units');open('c4');open('c1');
}
assert.equal(await first.done,0,read(join(root,'first-process.json')).stderr);
const report=read(join(runRoot,'scheduler/stop-report.json'));json(join(root,'initial-report.json'),report,true);assert.equal(report.status,'paused',JSON.stringify(report));
const started=(j:any,cids:string[])=>cids.map(c=>attempts(runRoot,j,c).length);
assert.deepEqual(started(next,all),[0,0,0,0,0],'the next block never starts');
if(mode==='streak'){
 assert.equal(report.reason,'consecutive-failure');assert.equal(merged(runRoot,job,'mono-4-c4').size,4);for(const c of c8)assert.equal(merged(runRoot,job,c).size,4,'c8 finished the block');assert.equal(merged(runRoot,job,'direct-c1').size,4);assert(report.pauseIds.length>=1);
 const refused=launch(root,runRoot,{...options,egress:{disabled}},'refused');assert.notEqual(await refused.done,0);assert.match(read(join(root,'refused-process.json')).stderr,/needs user authorization/);assert.equal(attempts(runRoot,job,'direct-c4').length,1,'a refused resume starts nothing');
}else{
 assert.equal(report.reason,mode==='planned'?'planned-stop':'egress-stop');assert.deepEqual(started(job,c8),[0,0],'c8 never started');assert(!groupStarted(runRoot,job.key,2,2));assert(!files(join(runRoot,'blocks',job.blockId,'direct-c8')).length,'no attempt left behind');
}
proof.firstReport={status:report.status,reason:report.reason,pauseIds:report.pauseIds};
const permanent=new Map(plan.jobs.flatMap(j=>j.units.flatMap(u=>[...merged(runRoot,j,u.configId)].filter(([,r])=>r.kind==='tasks'||r.data.disposition==='skipped').map(([id,r])=>[j.key+'/'+u.configId+'/'+id,r.attempt] as const))));
const firstEnd=events(runRoot).length;writeFileSync(disabled,'disabled');
if(existsSync(join(runRoot,'egress/stopped.json'))){
 await assert.rejects(recoverEgress(runRoot,''),/authorization/);await sleep(5200);proof.recovery=await recoverEgress(runRoot,'Authorized offline recovery; keep unknown fees');
}
const authorization=mode==='streak'?report.pauseIds.map((id:string)=>'pause:'+id).join(' ')+' Authorized offline resume after reviewing this pause':undefined;
const resume=launch(root,runRoot,{egress:{delayMs:10,disabled},...(authorization?{authorization}:{})},'resume');assert.equal(await resume.done,0,read(join(root,'resume-process.json')).stderr);
const final=read(join(runRoot,'scheduler/stop-report.json'));assert.equal(final.status,'complete',JSON.stringify(final));proof.finalReport={status:final.status,reason:final.reason};
for(const j of plan.jobs)for(const u of j.units){assert.equal(remaining(runRoot,j,u.configId).length,0);for(const [id,r] of merged(runRoot,j,u.configId)){const k=j.key+'/'+u.configId+'/'+id;if(permanent.has(k))assert.equal(r.attempt,permanent.get(k),'finished task was redone: '+k);}}
proof.permanentNotRedone=permanent.size;
// Order of the resume, read from what the resume itself logged and from the units' own times.
const later=events(runRoot).slice(firstEnd),rows=windows(runRoot,plan).filter(r=>r.job===job.key),groups=later.filter(e=>e.kind==='group-start'&&e.job===job.key).map(g=>[g.lane,g.laneGroup]);proof.resumeGroups=groups;
if(mode==='streak')assert.deepEqual(groups,[[2,1]],'only the paused config has work left');
else{assert(groups.findIndex(g=>g[0]===2&&g[1]===1)<groups.findIndex(g=>g[0]===2&&g[1]===2));const lastC4=Math.max(...rows.filter(r=>c4.includes(r.configId)).map(r=>r.end)),firstC8=Math.min(...rows.filter(r=>c8.includes(r.configId)).map(r=>r.start));assert(lastC4<=firstC8,'resume keeps c4 before c8');proof.resumeOrder={lastC4:new Date(lastC4).toISOString(),firstC8:new Date(firstC8).toISOString()};}
if(mode==='planned')for(const c of c4){const a=attempts(runRoot,job,c),done=files(join(a[0].path,'output/configs',c,'tasks')).map(p=>read(p).caseId);assert.equal(a.length,2);assert(!a[1].caseIds.some((id:string)=>done.includes(id)),'second attempt repeats no finished task');assert.equal(a[1].nonConcurrent,true);}
const result=exportRun(runRoot,join(runRoot,'export-1'));exportRun(runRoot,join(runRoot,'export-2'));for(const p of files(join(runRoot,'export-1')))assert(readFileSync(p).equals(readFileSync(p.replace('export-1','export-2'))));
assert(result.taskRows.every(r=>r.state==='skipped'||r.state==='completed'&&r.scoreStatus==='scored'));assert(result.taskRows.every(r=>Number.isInteger(r.lane)&&Number.isInteger(r.laneGroup)));
assert.deepEqual(await launcher.list(s.runId),[]);assert.equal(await count(),0);
const survivors=plan.jobs.flatMap(j=>j.caseIds.filter(id=>j.units.every(u=>merged(runRoot,j,u.configId).get(id)?.kind==='tasks')));
if(survivors.length){comparisonView(runRoot,join(root,'compare-input'));json(join(root,'cases.json'),survivors,true);const comp=await command(s.python,['-B','-X','utf8','scripts/compare.py','--new-run',join(root,'compare-input'),'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(root,'cases.json'),'--output',join(root,'comparison')],join(root,'comparison-process'));assert.equal(comp.code,0,comp.stdout+comp.stderr);proof.comparedCases=survivors.length;}
json(join(root,'verification.json'),{status:'PASS',imageId,...proof},true);console.log(JSON.stringify({status:'PASS',...proof,recovery:undefined}));
