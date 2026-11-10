// T9 segment A acceptance 5: consecutive failures across attempts, in real containers. The same file runs
// on the pre-change copy with --expect=no-pause to reproduce the gap, and here with --expect=pause.
// Uses only names that exist before the change.
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {attempts,merged,remaining} from '../src/ts/scheduler/records.ts';
import {read,json,lines,files,sleep,env,ROOT} from '../src/ts/scheduler/io.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {docker} from '../src/ts/docker/common.ts';
import {launcherFor} from '../src/ts/scheduler/launcher.ts';
import {connect} from '../src/ts/scheduler/control.ts';
import {recoverEgress,inFlight} from '../src/ts/scheduler/egress.ts';
const root=resolve(process.argv[2]),mode=process.argv[3],expect=process.argv.find(a=>a.startsWith('--expect='))?.slice(9);assert(['stop','kill','gap'].includes(mode));assert(['pause','no-pause'].includes(expect!));mkdirSync(root,{recursive:true});
const tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev',imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id;
const s=stage('t9-cross-'+mode);s.blockSize=4;s.launcher={kind:'docker',imageId,tag,runtime:{clockTicks:100,pageBytes:4096}};s.sampling.strict=true;s.stall={idleMs:120000,stopGraceMs:5000,pollMs:200};s.hostSampleMs=1000;
const runRoot=join(root,'run'),plan=freeze(s,runRoot),job=plan.jobs[0],cid='direct-c1',order=job.units[0].caseIds,[a,b,c]=order;
// stop/kill: a fails, b is held and cut off, b fails first in attempt 2. gap: a fails, b completes, c is held, c fails.
const held=mode==='gap'?c:b,releaseFile=join(root,'release-held'),holds=join(root,'holds.json');json(holds,{[`${cid}/${held}`]:releaseFile},true);
function launch(options:any,label:string){const path=join(root,label+'-options.json');json(path,options,true);const args=['--experimental-transform-types','tests/t8c-runner.ts',runRoot,path];
 const child=spawn(process.execPath,args,{cwd:ROOT,windowsHide:true,env:env(join(root,'guards',label)),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const done=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',code=>{json(join(root,label+'-process.json'),{command:['node',...args],pid:child.pid,code,stdout,stderr},true);yes(code);});});return {child,done};}
async function until(predicate:()=>boolean|Promise<boolean>,message:string,limit=240000){for(const end=Date.now()+limit;;){if(await predicate())return;if(Date.now()>end)throw Error('Timed out: '+message);await sleep(100);}}
const output=(attempt:any)=>join(attempt.path,'output/configs',cid),events=()=>lines(join(runRoot,'scheduler/events.jsonl'));
const first=launch({egress:{holds},unitFault:{skip:true,caseId:a}},'first'),launcher=launcherFor(runRoot,plan);
await until(()=>{assert.equal(first.child.exitCode,null,'scheduler left early');const x=attempts(runRoot,job,cid)[0];return !!x&&existsSync(join(output(x),'failures',a+'.r1.json'))&&(mode!=='gap'||existsSync(join(output(x),'tasks',b+'.r1.json')))&&existsSync(join(runRoot,'egress/status.json'))&&inFlight(runRoot,cid)>0;},'first failure recorded and next request held');
if(mode==='kill'){const ids=await launcher.list(s.runId);assert.equal(ids.length,1);await (await launcher.adopt(s.runId,ids[0]))!.kill('authorized offline fault injection');writeFileSync(releaseFile,'release');}
else{await connect(join(runRoot,'scheduler'),true);await until(()=>events().some(e=>e.kind==='planned-stop'),'planned stop dispatched');writeFileSync(releaseFile,'release');}
assert.equal(await first.done,0,read(join(root,'first-process.json')).stderr);
const report=read(join(runRoot,'scheduler/stop-report.json'));assert.equal(report.status,'paused');assert.notEqual(report.reason,'consecutive-failure');assert.deepEqual(report.pauseIds,[],'one failure alone pauses nothing');
const one=attempts(runRoot,job,cid)[0],firstFailure=read(join(output(one),'failures',a+'.r1.json'));assert.equal(firstFailure.streak,1);
const proof:any={mode,expect,order,held,firstReason:report.reason,firstFailure:{caseId:firstFailure.caseId,failureType:firstFailure.failureType,streak:firstFailure.streak}};
if(existsSync(join(runRoot,'egress/stopped.json'))){await sleep(5200);await recoverEgress(runRoot,'Authorized offline recovery; keep unknown fees');proof.recovered=true;}
const second=launch({egress:{delayMs:10},unitFault:{skip:true,caseId:held}},'second');assert.equal(await second.done,0,read(join(root,'second-process.json')).stderr);
const after=read(join(runRoot,'scheduler/stop-report.json')),two=attempts(runRoot,job,cid).at(-1),secondFailure=read(join(output(two),'failures',held+'.r1.json'));assert.equal(two.number,2);assert.equal(secondFailure.failureType,firstFailure.failureType,'same failure type');assert.equal(secondFailure.streak,1,'T7 restarts its count in the new attempt');
const pauses=files(join(runRoot,'scheduler/failure-pauses')).filter(p=>p.endsWith('.json')).map(p=>read(p));
proof.secondFailure={caseId:secondFailure.caseId,streak:secondFailure.streak};proof.secondReport={status:after.status,reason:after.reason,pauseIds:after.pauseIds};
if(expect==='no-pause'){assert.equal(after.status,'complete',JSON.stringify(after));assert.equal(pauses.length,0);}
else{
 assert.equal(after.status,'paused',JSON.stringify(after));assert.equal(after.reason,'consecutive-failure');assert.equal(pauses.length,1);const pair=pauses[0].details.crossAttempt[0];assert.equal(pair.earlier.caseId,a);assert.equal(pair.later.caseId,held);assert.equal(pair.earlier.attempt,1);assert.equal(pair.later.attempt,2);proof.pair={failureType:pair.failureType,earlier:pair.earlier.caseId,later:pair.later.caseId};
 const refused=launch({egress:{delayMs:10}},'refused');assert.notEqual(await refused.done,0);assert.match(read(join(root,'refused-process.json')).stderr,/needs user authorization/);
 const authorization=pauses.map(p=>'pause:'+p.pauseId).join(' ')+' Authorized offline resume after reviewing the cross-attempt failures';
 const third=launch({egress:{delayMs:10},authorization},'authorized');assert.equal(await third.done,0,read(join(root,'authorized-process.json')).stderr);const final=read(join(runRoot,'scheduler/stop-report.json'));assert.equal(final.status,'complete',JSON.stringify(final));proof.finalStatus=final.status;
}
assert.equal(remaining(runRoot,job,cid).length,0);const results=[...merged(runRoot,job,cid).values()];assert.equal(results.filter(r=>r.kind==='failures').length,2);
exportRun(runRoot,join(runRoot,'export-1'));exportRun(runRoot,join(runRoot,'export-2'));for(const p of files(join(runRoot,'export-1')))assert(readFileSync(p).equals(readFileSync(p.replace('export-1','export-2'))));
json(join(root,'verification.json'),{status:'PASS',imageId,...proof},true);console.log(JSON.stringify({status:'PASS',...proof}));
