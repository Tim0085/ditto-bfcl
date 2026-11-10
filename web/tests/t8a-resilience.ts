import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {ROOT,env,json,read,lines,sleep,files,alive} from '../src/ts/scheduler/io.ts';
import {freeze,matrix,type Plan} from '../src/ts/scheduler/plan.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {attempts,merged} from '../src/ts/scheduler/records.ts';
import {connect} from '../src/ts/scheduler/control.ts';
import {recoverEgress,inFlight} from '../src/ts/scheduler/egress.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {scoreJob,HostScorer} from '../src/ts/scheduler/scoring.ts';
import {schedulerLock} from '../src/ts/scheduler/lock.ts';
import {tmpdir} from 'node:os';
import {stage,comparisonView,command,referenceRoot} from './t8a-helpers.ts';
const root=resolve(process.argv[2]),scenario=process.argv[3]==='authorization'?'streak':process.argv[3],repeatPause=process.argv[3]==='authorization';mkdirSync(root,{recursive:true});
const hook=(options:any)=>{const url=pathToFileURL(join(ROOT,'tests/t8a-fault-hook.mjs'));url.searchParams.set('options',JSON.stringify(options));return url.href;};
async function until(predicate:()=>boolean|Promise<boolean>,description:string,ms=180000){const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return;await sleep(100);}throw new Error('Timed out: '+description);}
function launch(root:string,options:any,label:string){const file=join(root,label+'-options.json');json(file,options,true);const child=spawn(process.execPath,['--experimental-transform-types','tests/t8a-fault-runner.ts',root,file],{cwd:ROOT,env:env(join(root,label+'-guards')),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',code=>{json(join(root,label+'-process.json'),{command:[process.execPath,'--experimental-transform-types','tests/t8a-fault-runner.ts',root,file],pid:child.pid,code,stdout,stderr},true);yes(code);});});return {child,done};}
const s=stage('t8a-'+scenario),disabled=join(root,'fault-disabled'),signalFile=join(root,'tool-hang.json');
if(scenario==='streak'){s.configs=[matrix().find(c=>c.id==='direct-c1')!,{...matrix().find(c=>c.id==='mono-1-c1')!,id:'peer'}];s.blockSize=3;s.batches[0].caseIds=['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_base_12','multi_turn_base_13'];s.batches[0].configs=s.configs.map(c=>c.id);}
if(scenario==='tool-stall'){s.stall={idleMs:10000,stopGraceMs:700,pollMs:100};}
if(scenario==='model-stall'){s.stall={idleMs:10000,stopGraceMs:500,pollMs:500};s.egress.settings.model.timeoutMs=Number(process.argv[4]??600000);s.egress.retryPolicy.maxRetries=0;}
const plan=freeze(s,root),job=plan.jobs[0],first=job.units[0].caseIds[0],second=job.units[0].caseIds[1];
let opts:any={};
if(scenario==='streak')opts.unitImports=[hook({configId:'direct-c1',skip:true,disableFile:disabled})];
else if(scenario==='tool-stall')opts.unitImports=[hook({configId:'direct-c1',hangTool:true,signalFile,disableFile:disabled})];
else if(scenario==='egress-stop')opts.egressImports=[hook({stopEgress:true,disableFile:disabled})];
else if(scenario==='model-stall')opts.egressImports=[hook({delayMs:s.egress.settings.model.timeoutMs+5000,disableFile:disabled})];
else opts.egressImports=[hook({delayMs:100,disableFile:disabled})];
if(scenario==='planned')opts.unitImports=[hook({configId:'direct-c1',caseId:first,skip:true,disableFile:disabled})];
const run=launch(root,opts,'first');
await until(()=>existsSync(join(root,'scheduler','control.json')),'scheduler control');
await until(()=>files(join(root,'scheduler','units')).length>0,'unit allocation');
const launcher=new LocalProcessLauncher(join(root,'scheduler','units'));
if(scenario==='planned'){
 await until(()=>files(join(root,'blocks')).some(p=>p.includes('failures')&&p.endsWith(first+'.r1.json')),'skipped result');
 await until(()=>inFlight(root,'direct-c1')>0,'in-flight after skip');await connect(join(root,'scheduler'),true);
}else if(scenario==='unit-kill'){
 await until(()=>inFlight(root,'direct-c1')>0,'in-flight before forced unit exit');const ids=await launcher.list(s.runId);const u=await launcher.adopt(s.runId,ids[0]);await u!.kill('authorized offline fault injection');
}else if(scenario==='restart'){
 const blocked=launch(root,opts,'live-lock-rejected');assert.notEqual(await blocked.done,0);assert.match(read(join(root,'live-lock-rejected-process.json')).stderr,/Another scheduler is active/);
 await until(()=>inFlight(root,'direct-c1')>0,'in-flight before scheduler death');const ids=await launcher.list(s.runId);assert.equal(ids.length,1);run.child.kill('SIGKILL');await run.done;
 assert.equal(alive(read(schedulerLock).pid),false);console.log(JSON.stringify({defaultTemp:tmpdir(),runRoot:root,lock:schedulerLock,deadOwner:read(schedulerLock),liveOwnerRejected:true}));
 const secondRun=launch(root,opts,'restarted');await until(()=>lines(join(root,'scheduler','events.jsonl')).some(r=>r.kind==='adopt'),'restart adoption');
 const archived=lines(join(root,'scheduler','events.jsonl')).find(r=>r.kind==='stale-lock-archived');assert(archived);assert.equal(read(archived.path).pid,run.child.pid);json(join(root,'stale-lock-evidence.json'),read(archived.path),true);assert.deepEqual(await launcher.list(s.runId),ids);const u=await launcher.adopt(s.runId,ids[0]);assert(await u!.isAlive());await u!.stop('authorized adoption stop test');assert.equal(await secondRun.done,0);json(join(root,'restart-proof.json'),{sameUnitIds:ids,adoptedStop:true},true);
}
if(scenario!=='restart')assert.equal(await run.done,0,read(join(root,'first-process.json')).stderr);
const report=read(join(root,'scheduler','stop-report.json'));console.log(JSON.stringify({scenario,report}));assert.equal(report.status,'paused');
if(scenario==='unit-kill'){const before=exportRun(root,join(root,'export-before-resume'));assert.equal(before.summary[0].goodput,null);assert.equal(before.summary[0].completionRate,null);console.log('M7 before supplementation: goodput / completionRate null');}
const pre=job.units.map(u=>({configId:u.configId,records:[...merged(root,job,u.configId)].map(([id,r])=>({id,kind:r.kind,disposition:r.data.disposition,attempt:r.attempt}))}));json(join(root,'pre-resume.json'),pre,true);
if(scenario==='streak'){assert.equal(report.reason,'consecutive-failure');const peer=read(join(attempts(root,job,'peer')[0].path,'output','configs','peer','block-summary.json'));assert.equal(peer.completed,3);assert.equal(attempts(root,plan.jobs[1],'peer').length,0);}
if(scenario==='streak'){
 const original=readFileSync(join(root,'scheduler','stop-report.json'));
 for(const label of ['unauthorized-1','unauthorized-2']){const refused=launch(root,opts,label);assert.notEqual(await refused.done,0);assert.match(read(join(root,label+'-process.json')).stderr,/needs user authorization/);assert(original.equals(readFileSync(join(root,'scheduler','stop-report.json'))));}
 if(repeatPause){const firstNote='pause:'+read(files(join(root,'scheduler','failure-pauses'))[0]).pauseId+' 授权原文：测试再次暂停';const again=launch(root,{...opts,authorization:firstNote},'authorized-second-pause');assert.equal(await again.done,0);assert.equal(read(join(root,'scheduler','stop-report.json')).reason,'consecutive-failure');
 assert.equal(files(join(root,'scheduler','failure-pauses')).length,2);assert.equal(files(join(root,'scheduler','failure-authorizations')).length,1);
 const denied=launch(root,opts,'new-pause-refusal');assert.notEqual(await denied.done,0);assert.match(read(join(root,'new-pause-refusal-process.json')).stderr,/needs user authorization/);
 const auth=read(files(join(root,'scheduler','failure-authorizations'))[0]);assert.equal(auth.authorization,firstNote);assert(auth.pauseId&&auth.at&&auth.pausedAt);console.log(JSON.stringify({authorizationGate:'PASS',secondPauseRequiresNewAuthorization:true,auth}));}
}
if(scenario==='tool-stall'){assert(existsSync(signalFile));assert(lines(join(root,'scheduler','events.jsonl')).some(r=>r.kind==='force-kill'&&r.inFlight===0));assert([...merged(root,job,'direct-c1').values()].some(r=>r.data.disposition==='interrupted'));}
if(scenario==='model-stall'){const events=lines(join(root,'scheduler','events.jsonl'));assert(!events.some(r=>r.kind==='planned-stop'&&r.reason==='stall'));assert(!events.some(r=>r.kind==='force-kill'));}
if(existsSync(join(root,'egress','stopped.json'))){await assert.rejects(recoverEgress(root,''),/authorization/);const before=readFileSync(join(root,'egress','ledger.jsonl'),'utf8');const recovery=await recoverEgress(root,'User-authorized offline acceptance: reconcile synthetic requests and resume');assert(readFileSync(join(root,'egress','ledger.jsonl'),'utf8').startsWith(before));assert.equal(recovery.before.spentMicroUsd,recovery.after.spentMicroUsd);assert.equal(recovery.before.reservedMicroUsd+recovery.before.retainedMicroUsd,recovery.after.reservedMicroUsd+recovery.after.retainedMicroUsd);console.log(JSON.stringify({recovery}));}
const pendingIds=files(join(root,'scheduler','failure-pauses')).map(p=>read(p).pauseId).filter(id=>!existsSync(join(root,'scheduler','failure-authorizations',id+'.json')));writeFileSync(disabled,'disabled');const resumed=launch(root,{...opts,authorization:pendingIds.map(id=>'pause:'+id).join(' ')+' User-authorized offline acceptance resume'},'resumed');assert.equal(await resumed.done,0,read(join(root,'resumed-process.json')).stderr);assert.equal(read(join(root,'scheduler','stop-report.json')).status,'complete');
for(const j of plan.jobs)for(const unit of j.units){const records=merged(root,j,unit.configId);assert.equal(records.size,j.caseIds.length);for(const old of pre.find(p=>p.configId===unit.configId)?.records??[])if(j.key===job.key&&(old.kind==='tasks'||old.disposition==='skipped'))assert.equal(records.get(old.id).attempt,old.attempt);}
const surviving=(repeatPause?plan.jobs:[job]).flatMap(j=>j.caseIds.filter(id=>merged(root,j,'direct-c1').get(id)?.kind==='tasks'));
comparisonView(root,join(root,'compare-input'));json(join(root,'cases.json'),surviving,true);
const comp=await command(s.python,['-B','-X','utf8','scripts/compare.py','--new-run',join(root,'compare-input'),'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(root,'cases.json'),'--output',join(root,'comparison')],join(root,'comparison-process'));assert.equal(comp.code,0,comp.stdout+comp.stderr);console.log(comp.stdout);
// Scoring failures remain separate, and explicit offline rescoring appends records.
await scoreJob(root,plan,job,{score:async()=>({exitCode:2,timedOut:false,stdout:'',stderr:'injected scoring failure'})},true);
const failed=exportRun(root,join(root,'export-score-failure'));assert(failed.summary.some(r=>r.scoringFailed>0));
await scoreJob(root,plan,job,new HostScorer(s.python,join(root,'rescore-guards')),true);
exportRun(root,join(root,'export-1'));exportRun(root,join(root,'export-2'));for(const a of files(join(root,'export-1'))){const b=a.replace('export-1','export-2');assert(readFileSync(a).equals(readFileSync(b)));}
console.log(JSON.stringify({scenario,status:'PASS',finalRecords:plan.jobs.reduce((n,j)=>n+j.units.reduce((n,u)=>n+merged(root,j,u.configId).size,0),0),permanentRecordsNotRerun:true,exportByteIdentical:true}));
