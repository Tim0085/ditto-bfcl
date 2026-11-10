import {spawn,execFileSync} from 'node:child_process';
import {platform} from 'node:os';
import {openSync,closeSync,mkdirSync,existsSync,renameSync,unlinkSync,copyFileSync,writeSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ROOT,env,read,maybe,json,alive,sleep,now,lines,digest} from './io.ts';
import {connect} from './control.ts';
import {Ledger} from '../egress/ledger.ts';
import {reconcileRate} from './recovery-rate.ts';
import {launcherFor} from './launcher.ts';
import type {RunUnitLauncher} from '../run-unit.ts';
import {killOwnedTree} from './process-tree.ts';
import {randomUUID} from 'node:crypto';
import {acquireSchedulerLock} from './lock.ts';
import {attempts} from './records.ts';
/** Explicit operator action after a confirmed hung-request pause; liabilities are left to recoverEgress. */
export async function interruptHungEgress(root:string,authorization:string){
  if(!authorization?.trim())throw Error('Explicit user authorization is required');
  root=resolve(root);const plan=read(join(root,'plan.json')),lock=acquireSchedulerLock(root,plan.runId);
  try{return await interruptLocked(root,authorization,plan);}finally{lock.release();}
}
async function interruptLocked(root:string,authorization:string,plan:any){
  const report=read(join(root,'scheduler','stop-report.json'));
  if(!report.egressLeftRunning)throw Error('Only a recorded hung-egress pause can be interrupted here');
  const shell=join(root,'scheduler','egress'),endpoint=read(join(shell,'control.json'));
  const reportedAt=Date.parse(report.at),startedAt=Date.parse(endpoint.startedAt);
  if(report.runId!==plan.runId||endpoint.identity!==plan.runId+'/egress'||!Number.isFinite(reportedAt)||!Number.isFinite(startedAt)||startedAt>reportedAt)throw Error('Stale stop report or egress identity/runId mismatch');
  if(!alive(endpoint.pid)||existsSync(join(shell,'exit.json')))throw Error('Egress is already gone; use recover');
  let frozen=false;
  try{await connect(shell);}catch(error){
    const heartbeat=read(join(root,'egress','status.json'));
    if(!/Control timeout/.test(String(error))||!Number.isFinite(heartbeat.at)||Date.now()-heartbeat.at<=5000)throw error;
    frozen=true;
  }
  // T8c fix 1 / D4 (commander patch 2026-11-07): a frozen egress publishes no new heartbeat, so its last
  // counters cannot say which configuration is still waiting. On the frozen path unit liveness and
  // in-flight counts are recorded in the receipt, never required; identity, generation and the
  // still-stale heartbeat are. The non-frozen path keeps every original condition.
  if(!frozen&&!report.stuckUnits?.length)throw Error('Only a recorded hung-egress pause can be interrupted here');
  let status=frozen?read(join(root,'egress/status.json')):await observedStatus(root);
  if(status.pid!==endpoint.pid)throw Error('Egress heartbeat identity mismatch');
  flightCount(status);
  const launcher=launcherFor(root,plan),checked:{unitId:string;configId:string|null;alive:boolean|null;inFlight:number|null;unidentifiedInFlight:number|null;note?:string}[]=[];
  for(const unitId of report.stuckUnits??[]){
    // T9 B: on the frozen path a damaged attempt record is one more thing the receipt notes, like an unknown owner.
    let owners:{cid:string;path:string}[];
    try{owners=plan.jobs.flatMap((job:any)=>job.units.flatMap((u:any)=>attempts(root,job,u.configId).filter(a=>a.unitId===unitId).map(a=>({cid:u.configId,path:a.path}))));}
    catch(error){if(!frozen)throw error;checked.push({unitId,configId:null,alive:null,inFlight:null,unidentifiedInFlight:null,note:'attempt records unreadable: '+String(error)});continue;}
    if(owners.length!==1){if(!frozen)throw Error('Stuck unit has no unique owner in this root: '+unitId);checked.push({unitId,configId:null,alive:null,inFlight:null,unidentifiedInFlight:null,note:'no unique owner in this root'});continue;}
    let isAlive:boolean|null=null,note:string|undefined;
    try{const unit=await launcher.adopt(plan.runId,unitId);isAlive=!!unit&&await unit.isAlive();}catch(error){if(!frozen)throw error;note='liveness unknown: '+String(error);}
    if(!frozen&&!isAlive)throw Error('Recorded stuck unit is no longer alive: '+unitId);
    const flight=status.active[owners[0].cid]??0;if(!frozen&&flight<=0)throw Error('Recorded stuck configuration has no identified in-flight request: '+owners[0].cid);
    checked.push({unitId,configId:owners[0].cid,alive:isAlive,inFlight:flight,unidentifiedInFlight:status.active.__unidentified__??0,...(note?{note}:{})});
  }
  // Control records cannot be swapped between authentication and PID-only termination.
  if(digest(read(join(shell,'control.json')))!==digest(endpoint))throw Error('Egress control identity changed');
  if(frozen&&Date.now()-read(join(root,'egress/status.json')).at<=5000)throw Error('Egress heartbeat recovered; interruption refused');
  const receipt=join(root,'scheduler','egress','interruption-'+randomUUID()+'.json');
  const record={at:now(),authorization,planHash:plan.hash,pid:endpoint.pid,startedAt:endpoint.startedAt,stuckUnits:report.stuckUnits??[],checked,frozen,heartbeatAt:status.at,validatedAt:null as string|null,reason:frozen?'Control timeout and stale heartbeat; explicitly interrupt owned frozen egress; unit liveness and last counters are recorded only; unknown liabilities remain':'Confirmed live hung units and positive in-flight; unknown liabilities remain'};json(receipt,record,true);
  const pids=await killOwnedTree(endpoint.pid,join(root,'scheduler','guards','egress-interruption'),endpoint.startedAt,()=>{
    if(digest(read(join(shell,'control.json')))!==digest(endpoint)||digest(read(join(root,'scheduler/stop-report.json')))!==digest(report))throw Error('Egress control or stop report changed before interruption');
    status=read(join(root,'egress/status.json'));flightCount(status);const age=Date.now()-status.at;
    if(status.pid!==endpoint.pid||!Number.isFinite(status.at)||age<0||(frozen?age<=5000:age>5000))throw Error('Egress heartbeat no longer confirms the recorded interruption condition');
    for(const row of checked){if(row.configId===null)continue;const count=status.active[row.configId]??0;if(!frozen&&count<=0)throw Error('Stuck configuration drained before interruption: '+row.configId);row.inFlight=count;row.unidentifiedInFlight=status.active.__unidentified__??0;}
    record.heartbeatAt=status.at;record.validatedAt=now();json(receipt,record);
  });
  json(receipt,{...record,killedPids:pids,endedAt:now()});return {receipt,pids};
}
export async function ensureEgress(root:string,testImports:string[]=[],keyFile?:string){
  const directory=join(root,'scheduler','egress'),exit=join(directory,'exit.json');mkdirSync(directory,{recursive:true});
  if(existsSync(join(root,'egress','stopped.json')))throw new Error('Egress stopped; explicit recovery required');
  if(existsSync(join(directory,'control.json'))&&!existsSync(exit)){
    try{await connect(directory);return read(join(root,'egress','status.json')).url;}catch(error){const e=read(join(directory,'control.json'));if(alive(e.pid))throw error;throw new Error('Egress died; reconcile before restarting');}
  }
  if(existsSync(exit)){if(read(exit).code!==0)throw new Error('Egress exited abnormally; explicit reconciliation required');const n=Date.now();renameSync(exit,join(directory,`exit-${n}.json`));if(existsSync(join(directory,'control.json')))renameSync(join(directory,'control.json'),join(directory,`control-${n}.json`));}
  const out=openSync(join(directory,'stdout.log'),'a'),err=openSync(join(directory,'stderr.log'),'a');
  const child=spawn(process.execPath,['--experimental-transform-types',join(ROOT,'src/ts/scheduler/egress-shell.ts'),root,...(keyFile?[keyFile]:[])],{cwd:ROOT,env:env(join(root,'scheduler','guards','egress'),testImports),detached:true,windowsHide:true,stdio:['ignore',out,err]});closeSync(out);closeSync(err);child.unref();let error:unknown;child.on('error',e=>{error=e;});
  // Original limiter may spend 60s conservatively cooling historical clock
  // anomalies (including a recovered unknown tail at). Keep 60s for startup too.
  const deadline=Date.now()+120000;while(!existsSync(join(directory,'control.json'))){if(error||child.exitCode!==null||Date.now()>deadline)throw new Error('Egress startup failed: '+String(error??child.exitCode));await sleep(25);}
  await connect(directory);return read(join(root,'egress','status.json')).url;
}
// T8a fix 6: an egress killed hard leaves no exit record; a control record whose process is gone counts as exited.
export function egressDead(root:string){const shell=join(root,'scheduler','egress');if(existsSync(join(shell,'exit.json')))return true;const ctl=maybe(join(shell,'control.json'));return !!ctl&&!alive(ctl.pid);}
// T9 B: a run that never connected can still leave this root's egress alive; only the operator's interrupt path reads this.
// T9 C2: only this root's egress counts. control.json must exist and name a live pid with no exit record, and (the check
// killOwnedTree makes) that process must have been created no later than control.json's startedAt, so a reused pid or
// another live process is not taken for the egress. Synchronous because the scheduler's cleanup calls it that way; any doubt
// means no marker.
export function egressLeftAlive(root:string){const shell=join(root,'scheduler','egress');try{const ctl=maybe(join(shell,'control.json'));
  if(!ctl||!Number.isSafeInteger(ctl.pid)||ctl.pid<=0||!alive(ctl.pid)||existsSync(join(shell,'exit.json')))return false;
  const startedAt=Date.parse(ctl.startedAt);if(!Number.isFinite(startedAt))return false;
  if(platform()!=='win32')return true;const born=processBirth(ctl.pid,join(root,'scheduler','guards','egress-left'));return born!==null&&born<=startedAt;}catch{return false;}}
/** Creation time (epoch ms) of one Windows process, from the same Win32_Process.CreationDate that process-tree.ts reads; null when unknown. */
function processBirth(pid:number,report:string){
  const out=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";if($p){([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}`],{windowsHide:true,timeout:20000,env:env(report),encoding:'utf8'}).trim();
  return /^\d+$/.test(out)?Number(out):null;}
export async function closeEgress(root:string){const dir=join(root,'scheduler','egress');if(egressDead(root)||!existsSync(join(dir,'control.json')))return;await connect(dir,true);while(!egressDead(root))await sleep(50);}
function flightCount(status:any,configId?:string){
  if(!status.active||typeof status.active!=='object'||Array.isArray(status.active)||Object.values(status.active).some(n=>!Number.isSafeInteger(n)||Number(n)<0))throw Error('Invalid egress in-flight counters; never assume zero');
  return configId?(status.active[configId]??0)+(status.active.__unidentified__??0):Object.values(status.active).reduce<number>((a,b)=>a+Number(b),0);
}
function statusNow(root:string){const status=read(join(root,'egress','status.json'));if(!Number.isFinite(status.at)||Date.now()-status.at>5000||status.at>Date.now()+1000)throw new Error('Egress observation stale; never assume zero in-flight');flightCount(status);return status;}
async function observedStatus(root:string){for(let i=0;;i++){try{return statusNow(root);}catch(error){if(!/observation stale/.test(String(error))||i===3)throw error;await sleep(1000);}}}
export function inFlight(root:string,configId?:string){return flightCount(statusNow(root),configId);}
export async function inFlightWithRetry(root:string,configId?:string){return flightCount(await observedStatus(root),configId);}
export async function recoverEgress(root:string,authorization:string,launcher?:RunUnitLauncher){
  if(!authorization?.trim())throw new Error('Explicit user authorization is required');
  root=resolve(root);const lock=acquireSchedulerLock(root,read(join(root,'plan.json')).runId);
  try{return await recoverLocked(root,authorization,launcher);}finally{lock.release();}
}
async function recoverLocked(root:string,authorization:string,launcher?:RunUnitLauncher){
  // pid.json is the egress shell's record written before it takes gateway.lock (startup window).
  const directory=join(root,'egress'),shell=join(root,'scheduler','egress'),ctl=maybe(join(shell,'control.json'))??maybe(join(shell,'pid.json')),exit=maybe(join(shell,'exit.json'));
  if(ctl&&alive(ctl.pid)&&!exit)throw new Error('Egress is still alive; finish units and close it first');
  const units=launcher??launcherFor(root,read(join(root,'plan.json')));
  for(const unitId of await units.list(read(join(root,'plan.json')).runId)){const unit=await units.adopt(read(join(root,'plan.json')).runId,unitId);if(unit&&await unit.isAlive())throw new Error('Run unit still alive');}
  // T8a fix 6: an egress process that exited abnormally (non-zero exit record, or a
  // control record whose process is gone without one) can hold no live request.
  // Its status counters, gateway lock and half-written marker are leftovers; the
  // ledger alone decides which reservations stay as unknown fees.
  const crashed=exit?exit.code!==0:!!ctl&&!alive(ctl.pid),stopped=existsSync(join(directory,'stopped.json'));
  if(!stopped&&!crashed)throw new Error('No stopped marker to recover');
  const status=maybe(join(directory,'status.json'));if(!crashed&&status&&Object.values(status.active).some(n=>n!==0))throw new Error('In-flight requests not reconciled');
  // Without an exit record the only death evidence is the pid; a fresh heartbeat (written every 50ms) contradicts it.
  if(crashed&&!exit&&status&&Date.now()-status.at<5000)throw new Error('Egress heartbeat is fresh; it may still be alive');
  const lock=join(directory,'gateway.lock'),archive=join(directory,'recovery',Date.now()+'-'+randomUUID()),crash:any=crashed?{exit:exit??null,controlPid:ctl?.pid??null,staleActive:status?.active??null,stoppedMarker:stopped,archived:[]}:null;
  // A crash lock is never deleted: only a lock whose egress process is confirmed gone is archived.
  // Gateway's lock is empty; a recovery lock names its process, which must also be gone.
  if(crashed&&existsSync(lock)){
    let holder:any=null;try{holder=JSON.parse(readFileSync(lock,'utf8')||'null');}catch{holder=null;}
    if(holder?.pid&&alive(holder.pid))throw new Error('Another recovery holds the egress lock');
    mkdirSync(archive,{recursive:true});renameSync(lock,join(archive,'gateway.lock.crashed'));crash.archived.push('egress/gateway.lock');
  }
  // Acquire the same single-writer lock as Gateway, naming this recovery process.
  const token=randomUUID(),fd=openSync(lock,'wx');
  try{
    writeSync(fd,JSON.stringify({kind:'recovery',pid:process.pid,token,at:now()}));
    const config=read(join(root,'plan.json')).stage.egress;
    const ledger=await new Ledger(join(directory,'ledger.jsonl'),config.settings,config.mode,digest(config),config.dispatchPolicy.maxInFlight).open(true,true);
    const before=ledger.snapshot(),unknown=[...ledger.pending].map(([id,reserved])=>({id,...reserved}));
    mkdirSync(archive,{recursive:true});
    copyFileSync(join(directory,'ledger.jsonl'),join(archive,'ledger.jsonl.original'),2);
    const rate=reconcileRate(directory,ledger,archive);
    if(crashed&&status)copyFileSync(join(directory,'status.json'),join(archive,'status.json.crashed'),2);
    // A leftover temporary marker is archived on every recovery path.
    const leftover=existsSync(join(directory,'stopped.json.writing'));
    if(leftover){renameSync(join(directory,'stopped.json.writing'),join(archive,'stopped.json.writing'));crash?.archived.push('egress/stopped.json.writing');}
    json(join(archive,'authorization.json'),{authorization,at:now(),before,unknown,retained:[...ledger.retained.values()],rate,crash,archivedStoppedTemporary:leftover,reason:crashed?'Explicit recovery after abnormal egress exit; unknown fees remain reserved':'Explicit recovery; unknown fees remain reserved'},true);
    for(const id of [...ledger.pending.keys()])await ledger.retainFailedRequest(id,{reason:'transport_unknown',source:'authorized_recovery'});
    if(stopped)renameSync(join(directory,'stopped.json'),join(archive,'stopped.json'));
    // ensureEgress refuses an abnormal exit record; after recovery the next run starts a fresh egress.
    // control/pid first, the exit record (the hard evidence) last.
    if(crashed)for(const name of ['control.json','pid.json','exit.json'])if(existsSync(join(shell,name))){renameSync(join(shell,name),join(archive,'shell-'+name));crash.archived.push('scheduler/egress/'+name);}
    json(join(archive,'after.json'),{...ledger.snapshot(),crash},true);return {archive,before,after:ledger.snapshot(),unknown,crash};
  }finally{closeSync(fd);const own=maybe(lock);if(own?.pid!==process.pid||own?.token!==token)throw Error('Recovery gateway lock ownership changed; left untouched');unlinkSync(lock);}
}
