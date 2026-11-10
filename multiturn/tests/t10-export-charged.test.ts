// T10, no scheduler lock, no containers, no children: confirmedChargedCny in the blocks and tasks layers of the export.
// Without a charged confirmation it is null in summary, blocks and tasks (it used to be 0 in blocks and tasks); with one it
// carries the confirmed amount (0 CNY stays 0) in the block and the task it belongs to. tasks get confirmedChargedRequests,
// so modelRequests = settledRequests + confirmedFreeRequests + unknownRequests + confirmedChargedRequests per task.
// A summary over two blocks where only one has a charge still sums it. metadata describes the three layers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {scratch,stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {json} from '../src/ts/scheduler/io.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';

const prices={source:'t10 test',date:'2026-11-08',valley:{cachedInput:.02,uncachedInput:1,output:4},peak:{cachedInput:.04,uncachedInput:2,output:8}};
const CASES=['multi_turn_base_0','multi_turn_base_4'];
// Two blocks of one case each (blockSize 1), same configuration, category and round: one summary row over two blocks.
// Case 0: one settled request and one retained (unknown) request; case 4: one settled request.
function root(){
  const dir=scratch(),s:any=stage('t10-charged',CASES);s.prices=prices;s.blockSize=1;const p=freeze(s,dir);
  mkdirSync(join(dir,'egress'),{recursive:true});mkdirSync(join(dir,'scheduler'),{recursive:true});const ledger:any[]=[{kind:'header'}];
  for(const job of p.jobs){const cid=job.units[0].configId,caseId=job.caseIds[0],taskId=`${p.runId}/${cid}/r${job.round}/${caseId}`,a=join(dir,'blocks',job.blockId,cid,'r'+job.round,'attempt-1');
    json(join(a,'attempt.json'),{number:1,unitId:'u-'+caseId,caseIds:job.caseIds});
    json(join(a,'output','configs',cid,'tasks',`${caseId}.r${job.round}.json`),{caseId,taskId,configId:cid,round:job.round,status:'completed',modelSteps:[],completed:[],assignment:null,elapsedSeconds:1});
    ledger.push({kind:'reserve',id:caseId+'-1',configId:cid,caseId,taskId,microUsd:100,microCny:500},{kind:'settle',id:caseId+'-1',usage:{inputTokens:1000,cachedInputTokens:400,outputTokens:50,reasoningTokens:20},microUsd:7});
    if(caseId===CASES[0])ledger.push({kind:'reserve',id:'held-1',configId:cid,caseId,taskId,microUsd:100,microCny:500},{kind:'retain_failed',id:'held-1',heldMicroUsd:100,heldMicroCny:500});}
  writeFileSync(join(dir,'egress','ledger.jsonl'),ledger.map(r=>JSON.stringify(r)).join('\n')+'\n');
  return {dir,jobs:p.jobs};
}
const confirm=(dir:string,conclusion:string,chargedCny:number|null)=>writeFileSync(join(dir,'scheduler','fee-confirmations.jsonl'),
  JSON.stringify({version:1,kind:'fee-confirmation',requestId:'held-1',conclusion,chargedCny,userText:'用户确认',authorization:'t10 test',at:'2026-11-08T00:00:00Z'})+'\n');
const identity=(t:any)=>assert.equal(t.modelRequests,t.settledRequests+t.confirmedFreeRequests+t.unknownRequests+t.confirmedChargedRequests,'request identity for '+t.caseId);

test('no charged confirmation: confirmedChargedCny is null in summary, blocks and tasks; counts are 0',()=>{
  for(const conclusion of [null,'not-charged']){
    const x=root();if(conclusion)confirm(x.dir,conclusion,null);const e=exportRun(x.dir,join(x.dir,'export'));
    assert.equal(e.blockRows.length,2);assert.equal(e.summary.length,1);
    for(const b of e.blockRows){assert.equal(b.confirmedChargedCny,null,'block '+b.blockId+' '+conclusion);assert.equal(b.confirmedChargedRequests,0);}
    for(const t of e.taskRows){assert.equal(t.confirmedChargedCny,null,'task '+t.caseId+' '+conclusion);assert.equal(t.confirmedChargedRequests,0);identity(t);}
    assert.equal(e.summary[0].confirmedChargedCny,null);assert.equal(e.summary[0].confirmedChargedRequests,0);
    const t0=e.taskRows.find(t=>t.caseId===CASES[0]);assert.equal(t0.modelRequests,2);assert.equal(conclusion?t0.confirmedFreeRequests:t0.unknownRequests,1);
  }
});

test('charged: the amount sits in its block, its task and the summary; the other block and task stay null',()=>{
  for(const amount of [.3,0]){
    const x=root();confirm(x.dir,'charged',amount);const e=exportRun(x.dir,join(x.dir,'export'));
    const own=e.blockRows.find(b=>b.blockId===x.jobs.find((j:any)=>j.caseIds[0]===CASES[0])!.blockId),other=e.blockRows.find(b=>b!==own);
    assert.equal(own.confirmedChargedCny,amount,'0 CNY charged is a confirmed amount, not blank');assert.equal(own.confirmedChargedRequests,1);
    assert.equal(other.confirmedChargedCny,null);assert.equal(other.confirmedChargedRequests,0);
    const t0=e.taskRows.find(t=>t.caseId===CASES[0]),t4=e.taskRows.find(t=>t.caseId===CASES[1]);
    assert.equal(t0.confirmedChargedCny,amount);assert.equal(t0.confirmedChargedRequests,1);assert.equal(t0.unknownRequests,0);assert.equal(t0.settledRequests,1);
    assert.equal(t4.confirmedChargedCny,null);assert.equal(t4.confirmedChargedRequests,0);for(const t of e.taskRows)identity(t);
    assert.equal(e.summary[0].confirmedChargedCny,amount,'summary sums a block with a charge and a block without one');assert.equal(e.summary[0].confirmedChargedRequests,1);
    const tasksFile=JSON.parse(readFileSync(join(x.dir,'export','tasks.json'),'utf8')),blocksFile=JSON.parse(readFileSync(join(x.dir,'export','blocks.json'),'utf8'));
    assert.deepEqual(tasksFile.map((t:any)=>[t.caseId,t.confirmedChargedRequests,t.confirmedChargedCny]).sort(),[[CASES[0],1,amount],[CASES[1],0,null]]);
    assert.deepEqual(blocksFile.map((b:any)=>b.confirmedChargedCny).sort(),[amount,null].sort());
  }
});

test('metadata states the rule for all three layers and the request identity',()=>{
  const x=root();exportRun(x.dir,join(x.dir,'export'));const meta=JSON.parse(readFileSync(join(x.dir,'export','metadata.json'),'utf8'));
  assert.match(meta.costColumns,/all three layers: summary \(configuration x category x round\), blocks \(one configuration in one block\), tasks \(the requests of one task\)/);
  assert.match(meta.costColumns,/null never means "confirmed not charged"/);
  assert.match(meta.costColumns,/modelRequests = settledRequests \+ confirmedFreeRequests \+ unknownRequests \+ confirmedChargedRequests/);
});
