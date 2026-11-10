// Review S5b in real containers: a live unit authorized for one cross-attempt pair later brings a pair of another
// type; the run must ask for a new authorization. Moments are pinned by files (wait-entered, release), never by sleeps.
// Attempt 1: a fails (type X), y fails (type Y), unit killed while b waits. Attempt 2: b fails (X), scheduler killed
// while c waits, unit alive. Then: refused; authorized -> c fails (Y) -> new pause; refused; authorized -> complete.
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {attempts,remaining} from '../src/ts/scheduler/records.ts';
import {read,json,lines,files,sleep,env,ROOT,digest} from '../src/ts/scheduler/io.ts';
import {docker} from '../src/ts/docker/common.ts';
import {launcherFor} from '../src/ts/scheduler/launcher.ts';
const root=resolve(process.argv[2]);mkdirSync(root,{recursive:true});
const tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev',imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id;
const s=stage('t9-s5b',['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_base_12','multi_turn_base_13']);s.blockSize=6;
s.launcher={kind:'docker',imageId,tag,runtime:{clockTicks:100,pageBytes:4096}};s.sampling.strict=true;s.stall={idleMs:120000,stopGraceMs:5000,pollMs:200};s.hostSampleMs=1000;
const runRoot=join(root,'run'),plan=freeze(s,runRoot),job=plan.jobs[0],cid='direct-c1',[a,y,b,c]=job.units[0].caseIds;
function launch(options:any,label:string){const path=join(root,label+'-options.json');json(path,options,true);const args=['--experimental-transform-types','tests/t9-auth-runner.ts',runRoot,path];
 const child=spawn(process.execPath,args,{cwd:ROOT,windowsHide:true,env:env(join(root,'guards',label)),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const done=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',code=>{json(join(root,label+'-process.json'),{command:['node',...args],pid:child.pid,code,stdout,stderr},true);yes(code);});});return {child,done,stderr:()=>stderr};}
async function until(p:()=>boolean|Promise<boolean>,m:string,limit=240000){for(const end=Date.now()+limit;;){if(await p())return;if(Date.now()>end)throw Error('Timed out: '+m);await sleep(100);}}
const att=(n:number)=>attempts(runRoot,job,cid).find((x:any)=>x.number===n),out=(n:number)=>join(att(n).path,'output/configs',cid),failure=(n:number,id:string)=>join(out(n),'failures',id+'.r1.json');
const pauses=()=>files(join(runRoot,'scheduler/failure-pauses')).filter(p=>p.endsWith('.json')).map(p=>read(p).pauseId).sort();
const allow=(ids:string[],note:string)=>ids.map(i=>'pause:'+i).join(' ')+' '+note;
const refuse=async(label:string,authorization?:string)=>{const r=launch(authorization?{authorization}:{},label);const code=await r.done;assert.notEqual(code,0);assert.match(r.stderr(),/needs user authorization/);return code;};
const launcher=launcherFor(runRoot,plan),proof:any={order:{a,y,b,c}};
const first=launch({faults:{a1:{fail:{[a]:'CONTEXT.SELECT',[y]:'INTERACTION.ACT.TOOL'},waitCase:b}}},'first');
await until(()=>{assert.equal(first.child.exitCode,null,first.stderr());const x=att(1);return !!x&&existsSync(failure(1,a))&&existsSync(failure(1,y))&&existsSync(join(x.path,'logs','wait-entered'));},'a and y failed, b waiting');
{const ids=await launcher.list(s.runId);assert.equal(ids.length,1);await (await launcher.adopt(s.runId,ids[0]))!.kill('authorized offline fault injection');}
assert.equal(await first.done,0,first.stderr());
const X=read(failure(1,a)).failureType,Y=read(failure(1,y)).failureType;assert.notEqual(X,Y,'two failure types');assert.deepEqual([read(failure(1,a)).streak,read(failure(1,y)).streak],[1,1]);
proof.first={reason:read(join(runRoot,'scheduler/stop-report.json')).reason,pauses:pauses().length,X,Y};assert.equal(pauses().length,0);
const second=launch({faults:{a2:{fail:{[b]:'CONTEXT.SELECT',[c]:'INTERACTION.ACT.TOOL'},waitCase:c}}},'second');
await until(()=>{assert.equal(second.child.exitCode,null,second.stderr());const x=att(2);return !!x&&existsSync(failure(2,b))&&existsSync(join(x.path,'logs','wait-entered'));},'b failed, c waiting');
const ids=await launcher.list(s.runId);second.child.kill('SIGKILL');await second.done;assert.equal(ids.length,1);assert(await (await launcher.adopt(s.runId,ids[0]))!.isAlive(),'unit of attempt 2 still alive');
const unitId=att(2).unitId;proof.liveUnit=unitId;
await refuse('third-no-authorization');const p1=pauses();assert.deepEqual(p1,[digest(unitId+'/cross-attempt/'+X+'/'+b)]);proof.firstPause={id:p1[0],identity:unitId+'/cross-attempt/'+X+'/'+b};
const adoptedBefore=lines(join(runRoot,'scheduler/events.jsonl')).filter(e=>e.kind==='adopt').length;
const fourth=launch({authorization:allow(p1,'Authorized offline: reviewed the first cross-attempt pair')},'fourth-authorized');
await until(()=>{assert.equal(fourth.child.exitCode,null,fourth.stderr());return lines(join(runRoot,'scheduler/events.jsonl')).filter(e=>e.kind==='adopt').length>adoptedBefore;},'authorized run adopts the live unit');
writeFileSync(join(att(2).path,'logs','release'),'release');assert.equal(await fourth.done,0,fourth.stderr());
const report=read(join(runRoot,'scheduler/stop-report.json'));assert.equal(report.reason,'consecutive-failure',JSON.stringify(report));assert.equal(read(failure(2,c)).failureType,Y);assert.equal(read(failure(2,c)).streak,1,'T7 alone would not stop: b and c differ in type');
assert.equal(attempts(runRoot,job,cid).length,2,'the live unit was adopted, not replaced');
const p2=pauses().filter(i=>!p1.includes(i));assert.equal(p2.length,1,'the second pair on the same live unit is a new pause');
const details=read(join(runRoot,'scheduler/failure-pauses',p2[0]+'.json')).details;assert.deepEqual(details.crossAttempt.map((p:any)=>p.failureType+'/'+p.later.caseId).sort(),[X+'/'+b,Y+'/'+c].sort());
proof.secondPause={id:p2[0],pairs:details.crossAttempt.map((p:any)=>[p.failureType,p.earlier.caseId,p.later.caseId])};
await refuse('fifth-no-authorization');await refuse('fifth-old-pause-only',allow(p1,'old pause only'));
const sixth=launch({authorization:allow(p2,'Authorized offline: reviewed the second cross-attempt pair')},'sixth-authorized');assert.equal(await sixth.done,0,sixth.stderr());
assert.equal(read(join(runRoot,'scheduler/stop-report.json')).status,'complete');
const seventh=launch({},'seventh-no-authorization');assert.equal(await seventh.done,0,seventh.stderr());assert.equal(read(join(runRoot,'scheduler/stop-report.json')).status,'complete','authorized pauses are not asked again');
assert.equal(remaining(runRoot,job,cid).length,0);assert.equal(files(join(runRoot,'scheduler/failure-authorizations')).filter(p=>p.endsWith('.json')).length,2);
assert.deepEqual(await launcher.list(s.runId),[]);assert.equal((await docker(['ps','-aq','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+s.runId])).stdout.trim(),'');
json(join(root,'verification.json'),{status:'PASS',imageId,...proof},true);console.log(JSON.stringify({status:'PASS',...proof}));
