// T9 segment B item 11: every stop report names a still-running egress of this root, so the operator can always reach
// interrupt-egress; the frozen and identity checks stay. Offline, local units, real egress process.
// Usage: node --experimental-transform-types tests/t9-left-running.ts <directory> frozen-alive|frozen-exited|healthy
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {launch,until} from './t9-helpers.ts';
import {stage} from './t8a-helpers.ts';
import {freeze,matrix} from '../src/ts/scheduler/plan.ts';
import {read,json,files,sleep,alive,digest} from '../src/ts/scheduler/io.ts';
import {attempts,remaining} from '../src/ts/scheduler/records.ts';
import {launcherFor} from '../src/ts/scheduler/launcher.ts';
import {interruptHungEgress,recoverEgress} from '../src/ts/scheduler/egress.ts';
import {Ledger} from '../src/ts/egress/ledger.ts';
const base=resolve(process.argv[2]),mode=process.argv[3],root=join(base,mode);mkdirSync(root,{recursive:true});
const d=matrix().find(c=>c.id==='direct-c1')!,s=stage('t9left-'+mode,['multi_turn_base_0','multi_turn_base_4']);s.configs=[d,{...d,id:'peer'}];s.batches[0].configs=s.configs.map(c=>c.id);s.stall={idleMs:120000,stopGraceMs:500,pollMs:100};
const plan=freeze(s,root),job=plan.jobs[0],disabled=join(root,'disabled'),entered=join(root,'entered'),release=join(root,'release');
const report=()=>read(join(root,'scheduler','stop-report.json')),view=()=>{const r=report();return {status:r.status,reason:r.reason,egressLeftRunning:r.egressLeftRunning,stuckUnits:r.stuckUnits?.length??0};};
const ctl=()=>read(join(root,'scheduler','egress','control.json')),unitPids=()=>files(join(root,'blocks')).filter(p=>/logs.control\.json$/.test(p)).map(p=>read(p).pid);
const launcher=launcherFor(root,plan),unitsAlive=async()=>{for(const id of await launcher.list(plan.runId)){const u=await launcher.adopt(plan.runId,id);if(u&&await u.isAlive())return true;}return false;};
const attemptFile=()=>join(attempts(root,job,'direct-c1').at(-1)!.path,'attempt.json');
const ledger=()=>new Ledger(join(root,'egress','ledger.jsonl'),s.egress.settings,s.egress.mode,digest(s.egress),s.egress.dispatchPolicy.maxInFlight).open(true,true);
const result:any={mode};
const resume=async()=>{for(let i=1;i<=4;i++){const r=launch(root,root,{},'resume-'+i);await r.done;if(report().status==='complete'){result.runsToComplete=i;break;}}assert.equal(report().status,'complete',JSON.stringify(view()));};
async function finish(file:string,original:Buffer){
  for(const end=Date.now()+90000;Date.now()<end&&await unitsAlive();)await sleep(200);assert.equal(await unitsAlive(),false,'units exit once the egress is cut');
  await sleep(5300);writeFileSync(disabled,'x');
  // recover reads neither the attempt records nor the results; the damaged file is put right only before the next run.
  const recovered=await recoverEgress(root,'t9 confirmed: keep unknown fees and recover');result.unknown=recovered.unknown.length;assert(recovered.unknown.length>=1,'unknown fee kept');
  writeFileSync(join(root,'attempt-damaged-copy.json'),readFileSync(file));writeFileSync(file,original);
  await resume();const l=await ledger();assert.equal(l.pending.size,0);assert(l.retained.size>=recovered.unknown.length);result.retained=l.retained.size;
  assert.equal(plan.jobs.flatMap(j=>j.units.map(u=>remaining(root,j,u.configId).length)).reduce((a,b)=>a+b,0),0);
}
if(mode==='frozen-alive'||mode==='frozen-exited'){
  const first=launch(root,root,{egress:{entered,blockHeartbeatForever:true,disabled}},'first');result.firstExit=await first.done;result.first=view();assert.equal(report().egressLeftRunning,true);
  if(mode==='frozen-exited'){const pids=unitPids();for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}await until(()=>pids.every(p=>!alive(p)),'units dead');}
  const file=attemptFile(),original=readFileSync(file);writeFileSync(file,'{damaged');
  const second=launch(root,root,{},'second');result.secondExit=await second.done;result.second=view();
  assert.notEqual(result.secondExit,0);assert.equal(report().egressLeftRunning,true,'the replacing report keeps the mark');if(mode==='frozen-alive')assert(report().stuckUnits?.length>=1,'alive units are written as stuck');
  await assert.rejects(interruptHungEgress(root,'   '),/authorization/);
  const cut=await interruptHungEgress(root,'t9 confirmed: frozen egress, cut it and keep unknown fees');const receipt=read(cut.receipt);assert.equal(receipt.frozen,true);result.receipt={frozen:receipt.frozen,checked:receipt.checked.map((c:any)=>({configId:c.configId,alive:c.alive,note:c.note?.slice(0,60)}))};
  await finish(file,original);
}else if(mode==='healthy'){
  const first=launch(root,root,{egress:{entered,release,disabled}},'first');await until(()=>existsSync(entered),'held request');
  first.child.kill('SIGKILL');await first.done;const pids=unitPids();for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}await until(()=>pids.every(p=>!alive(p)),'units dead');
  const file=attemptFile(),original=readFileSync(file);writeFileSync(file,'{damaged');
  const second=launch(root,root,{},'second');result.secondExit=await second.done;result.second=view();assert.notEqual(result.secondExit,0);assert.equal(report().egressLeftRunning,true);
  // A healthy egress keeps every non-frozen check: first the damaged record itself, then units that are not alive.
  const pid=ctl().pid;assert(alive(pid));await assert.rejects(interruptHungEgress(root,'t9 must be refused: the egress is healthy'),/Invalid JSON record/);assert(alive(pid),'healthy egress untouched');
  writeFileSync(file,original);await assert.rejects(interruptHungEgress(root,'t9 must be refused: the egress is healthy'),/no longer alive|Only a recorded hung-egress pause/);assert(alive(pid),'healthy egress untouched');result.healthyRefused=2;
  // The killed units dropped their connections, so the egress stops by its own rule once the held request ends.
  writeFileSync(disabled,'x');writeFileSync(release,'go');await until(()=>existsSync(join(root,'egress','stopped.json')),'egress stop');
  const closing=launch(root,root,{},'closing');await closing.done;assert.equal(report().reason,'egress-stop');
  await sleep(300);const recovered=await recoverEgress(root,'t9 confirmed: keep unknown fees and recover');result.unknown=recovered.unknown.length;await resume();
}else if(mode==='normal-path'){
  // The normal return path: a stopped egress that never published its control record, still alive by pid.json.
  json(join(root,'egress','stopped.json'),{configId:'__global__',reason:'execution_stopped',at:Date.now()});json(join(root,'scheduler','egress','pid.json'),{pid:process.pid,at:new Date().toISOString()});
  const first=launch(root,root,{},'first');result.firstExit=await first.done;result.first=view();assert.equal(result.firstExit,0);assert.equal(report().reason,'egress-stop');assert.equal(report().egressLeftRunning,true);
}else throw Error('Unknown mode');
json(join(root,'result.json'),result);console.log(JSON.stringify({...result,pass:true}));process.exit(0);
