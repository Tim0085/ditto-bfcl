// T9 segment B acceptance: real mode through the real command line, real containers, a local HTTPS fake API.
// Usage: node --experimental-transform-types tests/t9-live-run.ts <scenario> --tag=<image tag>
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {existsSync,mkdirSync,writeFileSync,appendFileSync,readdirSync,rmSync,readFileSync} from 'node:fs';
import {FakeApi,certificates,fakeKeys,leakyError,liveStage,t8a,liveArgs,freezeLive,until,comparisonInput,ledgerRows,scratchRoot,targetedSplit,read,json,files,lines,sleep,ROOT,env} from './t9-live-helpers.ts';
import {stage as offlineStage,command,referenceRoot} from './t8a-helpers.ts';
import {docker} from '../src/ts/docker/common.ts';
import {merged} from '../src/ts/scheduler/records.ts';
import {matrix,categories} from '../src/ts/scheduler/plan.ts';
const scenario=process.argv[2],tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev';
const runRoot=join(scratchRoot,'l',scenario),aux=join(scratchRoot,'x',scenario);for(const old of [runRoot,aux])rmSync(old,{recursive:true,force:true});mkdirSync(aux,{recursive:true});
const tls=certificates(join(scratchRoot,'ca'),'C:/Program Files/Git/ucrt64/bin/openssl.exe');
let keys:ReturnType<typeof fakeKeys>;const api=await new FakeApi(()=>keys.apiKey).start(tls);keys=fakeKeys(scenario,api.url);
const runId='t9b-'+scenario,short=['multi_turn_base_50','multi_turn_long_context_50'],two=['direct-c1','mono-1-c1'];
const four=['multi_turn_base_198','multi_turn_miss_func_50','multi_turn_miss_param_50','multi_turn_long_context_50'];
const report=()=>read(join(runRoot,'scheduler','stop-report.json'));
const result:any={scenario};
let inspecting=false;
// Every container of this run, seen while it lives; the leak search reads this file.
const watcher=setInterval(async()=>{if(inspecting)return;inspecting=true;try{const ids=(await docker(['ps','-aq','--no-trunc','--filter','label=sec1.run='+runId],true)).stdout.trim().split(/\s+/).filter(Boolean);if(ids.length){const out=await docker(['inspect',...ids],true);if(out.code===0)appendFileSync(join(aux,'docker-inspect.jsonl'),JSON.stringify(JSON.parse(out.stdout))+'\n');}}catch{}finally{inspecting=false;}},1500);
const plain=(cases:string[])=>api.load(cases);
const freeze=(ids:string[],cases:string[],change?:(s:any)=>void)=>{plain(cases);return freezeLive(liveStage(runId,tag,ids,cases,change),runRoot,aux);};
const run=(label:string,hash:string,extra:any={})=>t8a(liveArgs(runRoot,keys.file,hash),aux,label,{ca:tls.ca,...extra});
const recover=(label='recover',text='t9 confirmed: keep unknown fees and recover')=>t8a(['recover','--root',runRoot,'--authorization',text],aux,label).done;
const egressPid=()=>read(join(runRoot,'scheduler','egress','control.json')).pid;
const stopped=()=>existsSync(join(runRoot,'egress','stopped.json'));
/** No new request reaches the fake API after a stop, also across a run that restarts nothing. */
async function silentAfterStop(hash:string){const before=api.received;await sleep(3000);assert.equal(api.received,before,'new request after stop');const again=await run('after-stop',hash).done;assert.equal(again.code,0,again.stderr);assert.equal(report().reason,'egress-stop');assert.equal(api.received,before,'new request from a run after stop');result.silentAfterStop=before;}
async function stoppedRun(hash:string){const r=await run('run-1',hash).done;assert.equal(r.code,0,r.stderr);const p=report();assert.equal(p.status,'paused');assert.equal(p.reason,'egress-stop');assert(stopped(),'stopped.json');result.report={status:p.status,reason:p.reason};return p;}
const unknown=(rows:any[])=>rows.filter(r=>r.kind==='reserve').length-rows.filter(r=>r.kind==='settle').length;
function liveGuardReports(){const rows=files(join(runRoot,'scheduler','guards','egress')).filter(p=>p.endsWith('.json')).map(p=>read(p));for(const r of rows){assert.equal(r.liveGuard,true);assert.equal(r.offlineGuard,false);assert.equal(r.keyFileReads,1);assert.equal(r.pinned,true);assert.equal(r.deniedOperations,0,JSON.stringify(r.denied));assert.deepEqual(r.children,[]);}return rows.length;}
const scenarios:Record<string,()=>Promise<void>>={
 async e2e(){
  const ids=['direct-c1','mono-8-c8','uniform-8-c8','targeted-8-c8'],plan=await freeze(ids,four);api.leak=true;
  const r=await run('run-1',plan.hash).done;assert.equal(r.code,0,r.stderr);assert.equal(report().status,'complete');
  assert.equal(api.mismatches,0);assert.equal(api.unauthorized,0);assert.deepEqual([...api.paths],['/chat/completions']);
  const led=ledgerRows(runRoot);assert.equal(led.settled,api.received);assert.equal(led.reserved,api.received);assert.equal(led.retained,0);
  // Data audit #48: the mode comes from the plan, so every task counts its real calls and names the source live; no retries here, so the three counts agree.
  const taskRows=plan.jobs.flatMap((job:any)=>job.units.flatMap((u:any)=>[...merged(runRoot,job,u.configId).values()])).filter((x:any)=>x.kind==='tasks').map((x:any)=>x.data);
  assert.equal(taskRows.length,ids.length*four.length);const realCalls=taskRows.reduce((n:number,t:any)=>n+t.realModelCalls,0);
  assert.equal(realCalls,led.settled,'sum of realModelCalls = settled');assert.equal(realCalls,api.received,'sum of realModelCalls = fake API requests');
  for(const t of taskRows){assert.equal(t.usageSource,'live',t.caseId);assert.equal(t.usage.source,'live',t.caseId);}
  const output=join(aux,'export'),ex=await t8a(['export','--root',runRoot,'--output',output],aux,'export').done;assert.equal(ex.code,0,ex.stderr);
  const summary=read(join(output,'summary.json'));assert(summary.length>=ids.length);
  for(const row of summary)for(const key of ['valleyCny','peakCny'])assert(typeof row[key]==='number'&&row[key]>0,`${row.configId}/${row.category}: ${key}=${row[key]}`);
  assert.equal(read(join(output,'metadata.json')).mode,'live');
  const input=join(aux,'compare-input'),count=comparisonInput(runRoot,input);json(join(aux,'cases.json'),four);
  const c=await command(plan.stage.python,['-B','-X','utf8','scripts/compare.py','--new-run',input,'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(aux,'cases.json'),'--output',join(aux,'comparison')],join(aux,'compare-process'));assert.equal(c.code,0,c.stdout+c.stderr);
  const sample=files(join(runRoot,'egress','model-records'))[0],raw=read(sample).rawResponse;assert.equal(raw.debug_echo,'key=[REDACTED]');assert.match(raw.debug_authorization,/\[REDACTED\]/);
  result.proof={received:api.received,settled:led.settled,realModelCalls:realCalls,tasks:taskRows.length,requestsCompared:count,peakFake:api.peak,guardReports:liveGuardReports(),cost:summary.map((s:any)=>({configId:s.configId,category:s.category,valleyCny:s.valleyCny,peakCny:s.peakCny})).slice(0,4),compare:c.stdout.slice(-400)};
 },
 async crash(){
  const plan=await freeze(two,short);let held=false;api.behavior=async()=>{if(!held){held=true;await api.hold();return true;}};
  const first=run('run-1',plan.hash);await until(()=>api.active>0,'first held request');
  process.kill(egressPid(),'SIGKILL');
  const r=await first.done;assert.equal(r.code,0,r.stderr);assert.equal(report().reason,'egress-stop');
  await sleep(5300);const noAuth=await recover('recover-empty','   ');assert.notEqual(noAuth.code,0);
  const rec=await recover();assert.equal(rec.code,0,rec.stderr);const unknownFees=JSON.parse(rec.stdout).unknown.length;assert(unknownFees>=1);
  api.behavior=undefined;const second=await run('run-2',plan.hash).done;assert.equal(second.code,0,second.stderr);
  for(let i=3;report().status!=='complete'&&i<=4;i++)assert.equal((await run('run-'+i,plan.hash).done).code,0);
  assert.equal(report().status,'complete');const led=ledgerRows(runRoot);assert.equal(led.retained,unknownFees);assert.equal(led.settled+led.retained,led.reserved);assert(api.received>=led.settled);
  result.proof={unknownFees,retained:led.retained,settled:led.settled,received:api.received,authorizations:readdirSync(join(runRoot,'scheduler','live-authorizations')).length};
 },
 async hang(){
  // A live request is always ended by timeoutMs, so "never settles" needs an egress that no longer runs: suspend it.
  const plan=await freeze(two,short,s=>{s.stall={idleMs:120000,stopGraceMs:1000,pollMs:100};});let held=false;api.behavior=async()=>{if(!held){held=true;await api.hold();return true;}};
  const first=run('run-1',plan.hash);await until(()=>api.active>0,'first held request');const pid=egressPid();
  const suspended=await command('powershell.exe',['-NoProfile','-File','tests/t9-suspend.ps1','-Id',String(pid)],join(aux,'suspend-process'));assert.equal(suspended.code,0,suspended.stderr);
  const r=await first.done;result.firstCode=r.code;const p=report();assert.equal(p.egressLeftRunning,true);result.report={status:p.status,reason:p.reason,stuckUnits:p.stuckUnits?.length??0,egressLeftRunning:p.egressLeftRunning};
  const empty=await t8a(['interrupt-egress','--root',runRoot,'--authorization','  '],aux,'interrupt-empty').done;assert.notEqual(empty.code,0);
  await sleep(5300);const cut=await t8a(['interrupt-egress','--root',runRoot,'--authorization','t9 confirmed: request hung, cut egress and keep unknown fees'],aux,'interrupt').done;assert.equal(cut.code,0,cut.stderr);
  const receipt=read(JSON.parse(cut.stdout).receipt);assert.equal(receipt.frozen,true);result.receipt={frozen:receipt.frozen,checked:receipt.checked.length,killed:receipt.killedPids?.length};
  await until(async()=>!(await docker(['ps','-q','--filter','label=sec1.run='+runId],true)).stdout.trim(),'units exit after egress cut');
  const rec=await recover();assert.equal(rec.code,0,rec.stderr);const unknownFees=JSON.parse(rec.stdout).unknown.length;assert(unknownFees>=1);
  api.behavior=undefined;for(let i=2;i<=4&&(i===2||report().status!=='complete');i++)assert.equal((await run('run-'+i,plan.hash).done).code,0);
  assert.equal(report().status,'complete');const led=ledgerRows(runRoot);assert(led.retained>=unknownFees);assert.equal(led.settled+led.retained,led.reserved);
  result.proof={unknownFees,retained:led.retained,settled:led.settled,received:api.received};
 },
 async cny(){
  const plan=await freeze(two,short,s=>{s.egress.settings.budget.referenceCny=1;});
  api.usage=()=>({prompt_tokens:30000,completion_tokens:1000,total_tokens:31000,prompt_cache_hit_tokens:0});
  await stoppedRun(plan.hash);const led=ledgerRows(runRoot),reserved=(32768*2+65536*8),settle=30000*2+1000*8,capacity=Math.floor((1e6-reserved)/settle)+1;
  assert.equal(api.received,led.reserved);assert(api.received<=capacity,`${api.received}>${capacity}`);await silentAfterStop(plan.hash);
  const noAuth=await recover('recover-empty',' ');assert.notEqual(noAuth.code,0);const rec=await recover();assert.equal(rec.code,0,rec.stderr);
  const before=api.received,again=await run('run-after-recover',plan.hash).done;assert.equal(again.code,0,again.stderr);assert.equal(api.received,before,'budget stays exhausted after recovery');
  result.proof={received:api.received,capacity,spentMicroCny:led.rows.filter(r=>r.kind==='settle').reduce((n,r)=>n+r.microCny,0),limitMicroCny:1e6};
 },
 async 'max-requests'(){
  const plan=await freeze(two,short,s=>{s.egress.settings.budget.maxRequests=3;});await stoppedRun(plan.hash);
  assert.equal(api.received,3);assert.equal(ledgerRows(runRoot).reserved,3);await silentAfterStop(plan.hash);result.proof={received:api.received,maxRequests:3};
 },
 async 'in-flight'(){
  // Resource rule 5 (at most 4 containers): four concurrency-8 configurations, 8 base cases in one block each, so 32 tasks ask at once.
  const ids=['direct-c8','mono-8-c8','uniform-8-c8','targeted-8-c8'],cases=['multi_turn_base_198','multi_turn_base_50','multi_turn_base_11','multi_turn_base_13','multi_turn_base_3','multi_turn_base_7','multi_turn_base_12','multi_turn_base_19'];
  const plan=await freeze(ids,cases,s=>{s.egress.dispatchPolicy.maxInFlight=3;s.stall.idleMs=300000;});assert.equal(plan.jobs.length,1,'one block');
  let gate=true;api.behavior=async()=>{if(gate)await api.hold();await sleep(100);};
  const first=run('run-1',plan.hash);await until(()=>api.active>=3,'three requests in flight',240000);
  await until(async()=>(await docker(['ps','-q','--filter','label=sec1.run='+runId],true)).stdout.trim().split(/\s+/).filter(Boolean).length>=4,'4 containers',120000);
  await sleep(6000);const heldPeak=api.peak,heldActive=api.active;gate=false;api.release();
  const r=await first.done;assert.equal(r.code,0,r.stderr);assert.equal(report().status,'complete');assert.equal(heldActive,3);
  assert(api.peak<=3,'peak above maxInFlight: '+api.peak);assert.equal(api.peak,3,'the limit was actually reached');
  const led=ledgerRows(runRoot);assert.equal(led.settled,api.received);assert.equal(api.mismatches,0);
  // After the run nothing more reaches the fake API.
  const before=api.received;await sleep(3000);assert.equal(api.received,before,'new request after the run');
  result.proof={configs:ids.length,cases:cases.length,maxInFlight:3,heldActive,heldPeak,peak:api.peak,received:api.received,settled:led.settled};
 },
 async 'per-task'(){
  // base_198 needs 3 requests, miss_func_50 needs 5: the limit ends the second as a task, the first finishes.
  const cases=['multi_turn_base_198','multi_turn_miss_func_50'],plan=await freeze(['direct-c1'],cases,s=>{s.egress.perTaskRequests=3;});
  const r=await run('run-1',plan.hash).done;assert.equal(r.code,0,r.stderr);assert.equal(report().status,'complete',JSON.stringify(report()));
  const rows=plan.jobs.flatMap((job:any)=>[...merged(runRoot,job,'direct-c1').values()]).filter((x:any)=>x.kind==='tasks').map((x:any)=>x.data),limit=rows.find((t:any)=>t.caseId===cases[1]),normal=rows.find((t:any)=>t.caseId===cases[0]);
  assert.equal(limit.termination?.reason,'request_limit');assert.equal(normal.termination,undefined);assert.equal(api.received,6);assert(!stopped());
  result.proof={limit:limit.termination,received:api.received,normalRequests:normal.usage.requests};
 },
 async 'retry-429'(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_50'],s=>{s.egress.dispatchPolicy.maxCooldownMs=120000;});
  api.behavior=(call,respond)=>{if(call.n<=2){respond(429,leakyError(keys.apiKey),{'retry-after':'33','x-request-id':keys.apiKey});return true;}};
  const r=await run('run-1',plan.hash).done;assert.equal(r.code,0,r.stderr);assert.equal(report().status,'complete',JSON.stringify(report()));
  const g=api.times.slice(1,3).map((t,i)=>t-api.times[i]),cooldowns=lines(join(runRoot,'egress','rate.cooldowns.jsonl'));
  assert(g[0]>=33000,'Retry-After honoured: '+g[0]);assert(g[1]>=60000,'backoff: '+g[1]);assert.equal(cooldowns.length,2);assert(cooldowns.every(c=>c.delayMs<=120000&&c.reason==='http_429'));
  const led=ledgerRows(runRoot);assert.equal(led.retained,2);result.proof={gapsMs:g,delays:cooldowns.map(c=>c.delayMs),received:api.received,retained:led.retained};
 },
 async 'retry-500'(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_50']);api.behavior=(_,respond)=>{respond(500,leakyError(keys.apiKey),{location:'https://example.invalid/?token='+keys.apiKey});return true;};
  await stoppedRun(plan.hash);assert.equal(api.received,3,'maxRetries 2 means three physical requests');await silentAfterStop(plan.hash);
  const led=ledgerRows(runRoot);result.proof={received:api.received,retained:led.retained,uncertain:led.uncertain,gapsMs:api.times.slice(1).map((t,i)=>t-api.times[i])};
 },
 async 'cooldown-limit'(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_50'],s=>{s.egress.dispatchPolicy.maxCooldownMs=35000;});
  api.behavior=(_,respond)=>{respond(429,{error:{message:'slow down'}},{'retry-after':'100'});return true;};
  await stoppedRun(plan.hash);assert.equal(api.received,1,'a cooldown beyond the limit never retries');await silentAfterStop(plan.hash);result.proof={received:api.received};
 },
 async timeout(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_50'],s=>{s.egress.settings.model.timeoutMs=3000;s.egress.retryPolicy.maxRetries=0;});
  api.behavior=async()=>{await api.hold();return true;};await stoppedRun(plan.hash);assert.equal(api.received,1);await silentAfterStop(plan.hash);
  const led=ledgerRows(runRoot);assert.equal(led.uncertain,1);assert.equal(led.settled,0);
  const rec=await recover();assert.equal(rec.code,0,rec.stderr);assert.equal(JSON.parse(rec.stdout).unknown.length,1);assert.equal(ledgerRows(runRoot).retained,1);
  api.behavior=undefined;const again=await run('run-after-recover',plan.hash).done;assert.equal(again.code,0,again.stderr);
  for(let i=0;report().status!=='complete'&&i<2;i++)assert.equal((await run('run-more-'+i,plan.hash).done).code,0);assert.equal(report().status,'complete');
  result.proof={received:api.received,retained:ledgerRows(runRoot).retained};
 },
 async 'timeout-body'(){
  // The headers arrive and the body never ends: the same limit must still end the request.
  const plan=await freeze(['direct-c1'],['multi_turn_base_50'],s=>{s.egress.settings.model.timeoutMs=3000;s.egress.retryPolicy.maxRetries=0;});
  api.behavior=async call=>{call.res.writeHead(200,{'content-type':'application/json'});call.res.write('{"id":');await api.hold();return true;};
  const started=Date.now();await stoppedRun(plan.hash);assert.equal(api.received,1);await silentAfterStop(plan.hash);const led=ledgerRows(runRoot);assert.equal(led.settled,0);assert.equal(led.uncertain,1);result.proof={received:api.received,uncertain:led.uncertain,runMs:Date.now()-started};
 },
 async overrun(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_50']);api.usage=()=>({prompt_tokens:5000000,completion_tokens:1000000,total_tokens:6000000,prompt_cache_hit_tokens:0});
  await stoppedRun(plan.hash);assert.equal(api.received,1);await silentAfterStop(plan.hash);const led=ledgerRows(runRoot);assert(led.rows.some(r=>r.kind==='settle'&&r.overrun===true));
  const rec=await recover();assert.notEqual(rec.code,0,'an overrun ledger stays blocked');result.proof={received:api.received,recoverRefused:rec.stderr.slice(-160)};
 },
 async 'wrong-model'(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_50']);api.behavior=(call,respond,self)=>{self.replay(call,(status,payload)=>respond(status,{...payload,model:'another-model'}));return true;};
  await stoppedRun(plan.hash);assert.equal(api.received,1);await silentAfterStop(plan.hash);result.proof={received:api.received,settled:ledgerRows(runRoot).settled};
 },
 async 'redact-401'(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_50']);api.behavior=(_,respond)=>{respond(401,leakyError(keys.apiKey),{location:'https://example.invalid/?token='+keys.apiKey,'x-request-id':'req-'+keys.apiKey});return true;};
  await stoppedRun(plan.hash);assert.equal(api.received,1);await silentAfterStop(plan.hash);result.proof={received:api.received};
 },
 async forge(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_198']),trigger=join(aux,'forge-now'),output=join(aux,'forge.json');
  // T9 C2: t8a.ts now refuses a --key-file that names no file before taking the lock; the not-a-key path must exist so that
  // "node child reruns the scheduler itself" still reaches the lock it is meant to test. It holds no key.
  writeFileSync(join(aux,'not-a-key'),'NOT_A_KEY=1\n');
  api.behavior=async()=>{if(!existsSync(output))await until(()=>existsSync(output),'forgery attempts');};
  const first=run('run-1',plan.hash,{forge:{runRoot,keyFile:keys.file,notKey:join(aux,'not-a-key'),python:plan.stage.python,trigger,output,authorization:`live:${plan.hash} forged`}});
  await until(()=>api.active>0,'first request');writeFileSync(trigger,'go');const r=await first.done;assert.equal(r.code,0,r.stderr);assert.equal(report().status,'complete');
  const f=read(output),row=(label:string)=>f.results.find((x:any)=>x.label.startsWith(label));
  assert.match(row('second egress from the scheduler, real key').thrown,/OFFLINE_GUARD: forbidden child.argument/);
  assert.notEqual(row('second egress from the scheduler, other').code,0);assert.match(row('second egress from the scheduler, other').output,/live guard alone/);
  for(const label of ['python child','node child sees']){assert.match(row(label).output,/egress-offline-guard/);assert.doesNotMatch(row(label).output,/egress-live-guard/);}
  for(const label of ['node child forges the scheduler argv, spawn','node child forges the scheduler argv, spawnSync']){const o=row(label).output;assert.match(o,/live guard alone/,o);assert.doesNotMatch(o,/"status":0/);}
  assert.match(row('node child reruns').output,/Another scheduler is active/);
  assert.match(f.schedulerReadsKeyFile,/OFFLINE_GUARD/);assert.match(f.schedulerListsKeyDirectory,/OFFLINE_GUARD/);
  const reports=files(join(aux,'guards')).concat(files(join(runRoot,'scheduler','guards'))).filter(p=>p.endsWith('.json')).map(p=>read(p)).filter(r=>r.offlineGuard===true),launches=reports.flatMap(r=>r.children.filter((c:any)=>c.liveEgress===true));
  assert.equal(launches.length,1,'exactly one launch used the exception');assert(String(launches[0].args[1]).endsWith('egress-shell.ts'));
  result.proof={rows:f.results.map((x:any)=>({label:x.label,code:x.code,thrown:x.thrown?.slice(0,80)})),schedulerKey:f.schedulerReadsKeyFile.slice(0,60),exceptionLaunches:launches.length,guardReports:liveGuardReports()};
 },
 async 'forge-offline'(){
  // An offline plan: the same forged launches get nothing, whatever the flags of the scheduler.
  const cases=four,s=offlineStage(runId,cases);s.egress.replay!.source=join(referenceRoot,'runs/multiturn-full800-001');const stageFile=join(aux,'stage.json');json(stageFile,s);
  const plan=await t8a(['plan','--stage',stageFile,'--root',runRoot],aux,'plan').done;assert.equal(plan.code,0,plan.stderr);const hash=read(join(runRoot,'plan.json')).hash;
  const withLive=await t8a(liveArgs(runRoot,keys.file,hash),aux,'run-live').done;assert.notEqual(withLive.code,0);assert.match(withLive.stderr,/offline plan must run without --live/);
  const trigger=join(aux,'forge-now'),output=join(aux,'forge.json');writeFileSync(trigger,'go');
  const r=await t8a(['run','--root',runRoot],aux,'run-1',{forge:{runRoot,keyFile:keys.file,notKey:join(aux,'not-a-key'),python:s.python,trigger,output,authorization:`live:${hash} forged`}}).done;assert.equal(r.code,0,r.stderr);assert.equal(report().status,'complete');
  assert(existsSync(output),'forgery attempts ran before the run ended');const f=read(output),other=f.results.find((x:any)=>x.label==='second egress from the scheduler, other path');assert.notEqual(other.code,0);assert.match(other.output,/an offline egress takes neither/);
  const reports=files(join(aux,'guards')).concat(files(join(runRoot,'scheduler','guards'))).filter(p=>p.endsWith('.json')).map(p=>read(p));assert.equal(reports.flatMap(r=>(r.children??[]).filter((c:any)=>c.liveEgress===true)).length,0);assert(reports.every(r=>r.liveGuard!==true));
  result.proof={rows:f.results.map((x:any)=>({label:x.label,code:x.code})),received:api.received};
 },
 async 'private-path'(){
  // The real key file lives under a directory named private: the scheduler must pass the path on without touching it.
  const plan=await freeze(['direct-c1'],['multi_turn_base_50']),hook=new URL('./t9-live-hook.mjs',import.meta.url).href;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File','tests/t9-private-key.ps1'],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env(join(aux,'guards','run'),[hook]),OFFLINE_GUARD_EXTRA_FORBIDDEN:JSON.stringify([join(scratchRoot,'keys')]),T9_CA_FILE:tls.ca,T9_KEY_SOURCE:keys.file,T9_RUN_ROOT:runRoot,T9_AUTHORIZATION:`live:${plan.hash} t9 key file under a directory named private`}});
  let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);const code=await new Promise(yes=>child.once('close',yes));writeFileSync(join(aux,'run.log'),out);assert.equal(code,0,out);
  assert.equal(report().status,'complete',JSON.stringify(report()));assert.equal(api.unauthorized,0);assert.equal(ledgerRows(runRoot).settled,api.received);
  const row=read(files(join(runRoot,'scheduler','live-authorizations'))[0]);assert.match(row.keyFile.replaceAll('\\','/'),/\/private\/fake-live\.keys$/);
  result.proof={received:api.received,settled:ledgerRows(runRoot).settled,keyDirectoryName:'private',guardReports:liveGuardReports()};
 },
 async 'bad-key'(){
  // A key file that is missing or wrong stops at the egress, before any request; a good one then runs on the same root.
  const plan=await freeze(['direct-c1'],['multi_turn_base_50']),good=readFileSync(keys.file,'utf8'),key='BFCL_API_KEY='+keys.apiKey+'\n',url=api.url;
  // T9 C2: a key file that does not exist no longer reaches the egress: t8a.ts refuses it before the authorization record,
  // the lock and the egress, without echoing the path. Stricter than before (refused earlier, nothing written).
  rmSync(keys.file,{force:true});const missing=await run('bad-missing',plan.hash).done;assert.notEqual(missing.code,0);assert.match(missing.stderr,/密钥文件路径不存在或为空/);
  assert.ok(!missing.stderr.includes(keys.file));assert.ok(!existsSync(join(runRoot,'scheduler','live-authorizations')));assert.equal(api.received,0);
  const bad:Record<string,string|null>={http:`BFCL_BASE_URL=http://127.0.0.1:${api.port}\n${key}`,account:`BFCL_BASE_URL=https://user:pass@127.0.0.1:${api.port}\n${key}`,query:`BFCL_BASE_URL=${url}?x=1\n${key}`,noKey:`BFCL_BASE_URL=${url}\n`,noUrl:key};
  const rows:any={missing:'refused by t8a.ts: 密钥文件路径不存在或为空'};for(const [label,text] of Object.entries(bad)){rmSync(keys.file,{force:true});if(text!==null)writeFileSync(keys.file,text);const r=await run('bad-'+label,plan.hash).done;assert.notEqual(r.code,0,label);const p=report();assert.equal(p.reason,'scheduler-error',label);assert.match(p.error,/Egress startup failed/);assert.equal(api.received,0,label);rows[label]=p.error;}
  writeFileSync(keys.file,good);const r=await run('good',plan.hash).done;assert.equal(r.code,0,r.stderr);assert.equal(report().status,'complete');assert.equal(ledgerRows(runRoot).settled,api.received);
  result.proof={rows,received:api.received,authorizations:readdirSync(join(runRoot,'scheduler','live-authorizations')).length};
 },
 async templates(){
  // Each real-stage template with test numbers in a copy: it freezes through the command line, starts, asks the fake API, and stops as planned.
  // Old records cannot serve here: base and long-context cases share request bodies but not replies. Any plain answer proves the start.
  // Resource rule 5 (at most 4 containers): only live-profile (1 container) runs; the other three freeze on the real test image and start nothing.
  api.behavior=(_,respond)=>{respond(200,{id:'t9',model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'done'}}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});return true;};const rows:any[]=[];
  const expected:Record<string,number>={'live-profile':32,'live-pilot':56,'live-slice':380,'live-main':43200};
  for(const name of ['live-profile','live-pilot','live-slice','live-main']){
   const file=join(ROOT,'config/stages',name+'.json'),original=readFileSync(file),template=read<any>(file),root=join(scratchRoot,'l','tp-'+name.slice(5)),side=join(aux,name),before=api.received;rmSync(root,{recursive:true,force:true});
   // The formal file stays blank: with only the image tag changed, freezing through the command line is refused for the blank limits.
   const blank=read<any>(file);blank.runId='t9b-tb-'+name.slice(5);blank.launcher.tag=tag;const blankFile=join(side,'blank-stage.json');mkdirSync(side,{recursive:true});json(blankFile,blank);
   const blankRoot=join(scratchRoot,'l','tb-'+name.slice(5));rmSync(blankRoot,{recursive:true,force:true});const refused=await t8a(['plan','--stage',blankFile,'--root',blankRoot],side,'plan-blank').done;
   assert.notEqual(refused.code,0,name+' blank froze');assert.match(refused.stderr,/A real stage needs a finite positive referenceUsd/,name);assert(!existsSync(join(blankRoot,'plan.json')),name+' blank plan written');
   if(name==='live-profile')assert.equal(template.targetedSplit,undefined);else assert.match(template.targetedSplit,/^TARGETED_SPLIT_REQUIRED/,name);
   const s=structuredClone(template);s.runId='t9b-tp-'+name.slice(5);s.launcher.tag=tag;if(s.targetedSplit)s.targetedSplit=targetedSplit;s.prices={source:'t9 test numbers, not billing',date:'2026-11-07',valley:{cachedInput:.02,uncachedInput:1,output:4},peak:{cachedInput:.04,uncachedInput:2,output:8}};
   Object.assign(s.egress.settings.budget,{referenceUsd:1000,referenceCny:1000,maxRequests:100000,peakCnyPerMillion:{cachedInput:.04,uncachedInput:2,output:8}});s.egress.settings.model.referencePrice={inputPerMillion:.3,outputPerMillion:1.2};s.stall={...s.stall,stopGraceMs:5000,pollMs:200};
   const plan=await freezeLive(s,root,side),tasks=plan.jobs.reduce((n:number,j:any)=>n+j.units.reduce((m:number,u:any)=>m+u.caseIds.length,0),0);assert.equal(tasks,expected[name],name+' scale');
   // Selection and lanes as in the template; the targeted split is the one given in place of TARGETED_SPLIT_REQUIRED.
   for(const [i,batch] of template.batches.entries()){
    const frozen=plan.stage.batches[i];assert.deepEqual(frozen.configs,batch.configs);assert.deepEqual(frozen.lanes,batch.lanes,name+' lanes');
    const chosen=new Set(plan.jobs.filter((j:any)=>j.batch===batch.id&&j.round===1).flatMap((j:any)=>j.caseIds)),want=Array.isArray(batch.caseIds)?batch.caseIds:null;
    if(want)assert.deepEqual([...chosen].sort(),[...want].sort(),name+' selection');else assert.equal(chosen.size,batch.caseIds==='all'?800:32,name+' selection');
    for(const job of plan.jobs.filter((j:any)=>j.batch===batch.id))for(const u of job.units)assert.equal(u.caseIds.length,job.caseIds.length);
   }
   const split=read<any>(targetedSplit);
   if(template.targetedSplit){assert.deepEqual(plan.targeted,split,name+' split');for(const job of plan.jobs)for(const u of job.units.filter((u:any)=>plan.stage.configs.find((c:any)=>c.id===u.configId)?.copies==='profile'))assert.deepEqual(u.copies,split.byCategory[job.category].copies);}
   const row:any={name,planJobs:plan.jobs.length,tasks,lanes:template.batches.map((b:any)=>b.lanes??null),blankRefused:true,targetedSplit:template.targetedSplit??null};
   if(name==='live-profile'){
    const first=t8a(liveArgs(root,keys.file,plan.hash),side,'run',{ca:tls.ca});await until(()=>api.received>=before+3,name+' reaches the fake API',240000);
    const stop=await t8a(['stop','--root',root],side,'stop').done;assert.equal(stop.code,0,stop.stderr);const r=await first.done;assert.equal(r.code,0,r.stderr);const p=read(join(root,'scheduler','stop-report.json'));assert.equal(p.reason,'planned-stop');
    Object.assign(row,{received:api.received-before,status:p.status,reason:p.reason});
   }else{
    assert.equal((await docker(['ps','-aq','--filter','label=sec1.run='+s.runId],true)).stdout.trim(),'',name+' started a container');assert.equal(api.received,before,name+' asked the fake API');
    Object.assign(row,{containers:0,received:0});
   }
   assert(readFileSync(file).equals(original),name+' formal file changed');rows.push(row);
  }
  result.proof={rows};
 },
 async ps1(){
  const plan=await freeze(['direct-c1'],['multi_turn_base_50']),stageFile=join(aux,'stage.json'),hook=new URL('./t9-live-hook.mjs',import.meta.url).href;
  const args=['-NoProfile','-File','scripts/t8a-stage.ps1','-Stage',stageFile,'-Root',runRoot,'-Live','-EnvFile',keys.file,'-LiveAuthorization',`live:${plan.hash} t9 through the one-command entry`];
  const child=spawn('powershell.exe',args,{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env(join(aux,'guards','ps1'),[hook]),OFFLINE_GUARD_EXTRA_FORBIDDEN:JSON.stringify([join(scratchRoot,'keys')]),T9_CA_FILE:tls.ca}});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);
  const code=await new Promise(yes=>child.once('close',yes));writeFileSync(join(aux,'ps1.log'),out);assert.equal(code,0,out);assert.equal(report().status,'complete');
  const refused=await t8a(['run','--root',runRoot],aux,'no-live').done;assert.notEqual(refused.code,0);assert.match(refused.stderr,/needs --live/);
  const row=read(files(join(runRoot,'scheduler','live-authorizations'))[0]);assert.equal(row.keyFile.replaceAll('\\','/').toLowerCase(),keys.file.replaceAll('\\','/').toLowerCase());assert.equal(row.planHash,plan.hash);assert.equal(row.limits.maxInFlight,plan.stage.egress.dispatchPolicy.maxInFlight);
  result.proof={received:api.received,record:Object.keys(row)};
 },
};
if(!scenarios[scenario])throw Error('Unknown scenario '+scenario);
try{await scenarios[scenario]();result.pass=true;console.log(JSON.stringify(result));json(join(aux,'result.json'),result);}
finally{clearInterval(watcher);await api.stop();}
process.exit(0);
