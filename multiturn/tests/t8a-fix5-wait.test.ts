import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scratch,stage} from './t8a-helpers.ts';
import {ROOT,read,lines,json,now} from '../src/ts/scheduler/io.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
test('M4 legal retry wait at 1:300 scale exceeds idle threshold without a stall pause',async()=>{
 const root=scratch(),s=stage('wait-fix5',['multi_turn_base_0']);s.stall={idleMs:3000,stopGraceMs:1000,pollMs:50};s.egress.settings.model.timeoutMs=2000;s.egress.retryPolicy.maxRetries=2;s.egress.dispatchPolicy.maxCooldownMs=3000;
 freeze(s,root);const hook=pathToFileURL(join(ROOT,'tests/t8a-fix5-wait-hook.mjs'));hook.searchParams.set('options',JSON.stringify({trace:join(root,'wait.jsonl'),thirdMs:1900}));
 const report=await runSchedule(root,new LocalProcessLauncher(join(root,'scheduler/units')),{egressImports:[hook.href]});assert.equal(report.status,'complete');
 const trace=lines(join(root,'wait.jsonl')),quiet=trace[5].end-trace[0].start,events=lines(join(root,'scheduler/events.jsonl'));assert(quiet>=5900);assert(!events.some(r=>r.reason==='stall'||r.kind==='force-kill'));assert.equal(lines(join(root,'egress/ledger.jsonl')).filter(r=>r.kind==='retain_failed').length,2);
 console.log(JSON.stringify({M4:'PASS',root,scale:'timeout 600000/300=2000; idle 900000/300=3000; backoffs 30000/300=100,60000/300=200',quietMs:quiet,idleMs:3000,report}));
});
test('M4 no request and no activity: finite stall pause, cooperative stop, no force kill',async()=>{
 const root=scratch(),s=stage('true-idle-fix5',['multi_turn_base_0']);s.egress.backend='fixtures';s.stall={idleMs:500,stopGraceMs:1000,pollMs:50};freeze(s,root);
 let live=true,stops=0,kills=0,start=0;
 const result=await runSchedule(root,{kind:'local-process',toUnitView:s=>s.block,list:async()=>[],adopt:async()=>undefined,start:async spec=>{start=Date.now();return {unitId:spec.unitId,isAlive:async()=>live,stop:async()=>{stops++;live=false;},kill:async()=>{kills++;},wait:async()=>({startedAt:new Date(start).toISOString(),endedAt:now(),exitCode:0,signal:null,killed:false,stoppedByPlan:true,oomKilled:null,summary:null})};}});
 const elapsed=Date.now()-start;assert.equal(result.reason,'stall');assert.equal(stops,1);assert.equal(kills,0);assert(elapsed>=500&&elapsed<6000);console.log(JSON.stringify({M4:'PASS',root,elapsedMs:elapsed,stops,kills,result}));
});
