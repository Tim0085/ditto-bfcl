// T9 C3, no scheduler lock, no containers, no children: the export fixes.
// #1 a confirmed-charged request keeps the full-usage columns null and is counted in confirmedChargedCny (null when none);
// #2 graphTimes keys tell null from undefined, exactly like the pre-T9 algorithm.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {scratch,stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {graphTimesFromRows} from '../src/ts/scheduler/export-graph.ts';
import {fileHash} from '../src/ts/scheduler/export-stream.ts';

// ---------------------------------------------------------------- #1 charged confirmations
const prices={source:'t9c3 test',date:'2026-11-08',valley:{cachedInput:.02,uncachedInput:1,output:4},peak:{cachedInput:.04,uncachedInput:2,output:8}};
function chargedRoot(){
  const root=scratch(),s:any=stage('t9c3-charged',['web_search_no_snippet_0']);s.prices=prices;const p=freeze(s,root),cid='direct-c1',taskId=`${p.runId}/${cid}/r1/web_search_no_snippet_0`;
  mkdirSync(join(root,'egress'),{recursive:true});mkdirSync(join(root,'scheduler'),{recursive:true});
  const ledger=[{kind:'header'},
    {kind:'reserve',id:'dddddddd-1',configId:cid,caseId:'web_search_no_snippet_0',taskId,microUsd:100,microCny:500},{kind:'settle',id:'dddddddd-1',usage:{inputTokens:1000,cachedInputTokens:400,outputTokens:50,reasoningTokens:20},microUsd:7},
    {kind:'reserve',id:'dddddddd-2',configId:cid,caseId:'web_search_no_snippet_0',taskId,microUsd:100,microCny:500},{kind:'retain_failed',id:'dddddddd-2',heldMicroUsd:100,heldMicroCny:500}];
  writeFileSync(join(root,'egress','ledger.jsonl'),ledger.map(r=>JSON.stringify(r)).join('\n')+'\n');
  return root;
}
const confirm=(root:string,conclusion:string,chargedCny:number|null)=>writeFileSync(join(root,'scheduler','fee-confirmations.jsonl'),
  JSON.stringify({version:1,kind:'fee-confirmation',requestId:'dddddddd-2',conclusion,chargedCny,userText:'用户确认',authorization:'t9c3 test',at:'2026-11-08T00:00:00Z'})+'\n');
// settled usage x valley: (1000-400)*1 + 400*.02 + 50*4 = 808 per million
const knownValley=808/1e6,knownPeak=1616/1e6;
const full=['valleyCny','peakCny','inputTokens','cachedTokens','outputTokens','uncachedInputTokens','reasoningTokens'];

test('#1 no confirmation: the unknown request keeps the full-usage columns null, confirmedChargedCny is null',()=>{
  const root=chargedRoot(),x=exportRun(root,join(root,'export')),r=x.summary[0];
  assert.equal(r.unknownRequests,1);for(const k of ['valleyCny','peakCny','inputTokens','reasoningTokens'])assert.equal(r[k],null,k);
  assert.equal(r.confirmedChargedRequests,0);assert.equal(r.confirmedChargedCny,null);assert.equal(r.knownValleyCny,knownValley);
});

test('#1 not-charged: unchanged behaviour, 0 CNY, the full-usage columns are known, confirmedChargedCny null',()=>{
  const root=chargedRoot();confirm(root,'not-charged',null);const r=exportRun(root,join(root,'export')).summary[0];
  assert.equal(r.unknownRequests,0);assert.equal(r.confirmedFreeRequests,1);assert.equal(r.confirmedChargedRequests,0);assert.equal(r.confirmedChargedCny,null);
  assert.equal(r.valleyCny,knownValley);assert.equal(r.peakCny,knownPeak);assert.equal(r.inputTokens,1000);assert.equal(r.cachedTokens,400);assert.equal(r.outputTokens,50);assert.equal(r.uncachedInputTokens,600);assert.equal(r.reasoningTokens,20);
});

test('#1 charged: the full-usage columns stay null, confirmedChargedCny carries the amount, the ledger is only read',()=>{
  for(const amount of [.3,0]){
    const root=chargedRoot(),ledger=fileHash(join(root,'egress','ledger.jsonl'));confirm(root,'charged',amount);
    const x=exportRun(root,join(root,'export')),r=x.summary[0],b=x.blockRows[0];
    assert.equal(r.unknownRequests,0,'confirmed, so no longer unknown');assert.equal(r.unknownHeldPeakCny,0);assert.equal(r.confirmedFreeRequests,0);
    assert.equal(r.confirmedChargedRequests,1);assert.equal(r.confirmedChargedCny,amount,'0 CNY charged is a confirmed amount, not blank');
    for(const k of full)assert.equal(r[k],null,'summary.'+k+' with amount '+amount);
    for(const k of ['inputTokens','cachedTokens','outputTokens'])assert.equal(b[k],null,'block.'+k);
    // the settled part stays as it was, and does not contain the confirmed amount
    assert.equal(r.knownValleyCny,knownValley);assert.equal(r.knownPeakCny,knownPeak);assert.equal(r.recordedInputTokens,1000);assert.equal(r.recordedReasoningTokens,20);
    assert(r.missing.includes('valleyCny')&&r.missing.includes('inputTokens'),'null full-usage columns are listed as missing, as for unknown requests');
    assert.equal(fileHash(join(root,'egress','ledger.jsonl')),ledger);
    const meta=JSON.parse(readFileSync(join(root,'export','metadata.json'),'utf8'));
    assert(!meta.feeConfirmations.rule.includes('leaves the unknown hold'));assert.match(meta.feeConfirmations.rule,/ledger\.jsonl is never written/);assert.match(meta.costColumns,/confirmedChargedCny/);
    assert.deepEqual(meta.feeConfirmations.applied,['dddddddd-2']);
  }
});

// ---------------------------------------------------------------- #2 graphTimes keys
// The pre-T9 export.ts graphTimes, verbatim (runs/offline/t9-20261107/c1/landing/originals/src/ts/scheduler/export.ts:20-27),
// only the events argument replaces the file read.
function oldGraphTimes(events:any[],raw:any[]){const times=new Map<string,number>();
 for(const start of events.filter(e=>e.event?.status==='started')){const end=events.find(e=>e.taskId===start.taskId&&e.event.iteration===start.event.iteration&&e.event.status!=='started');if(!end)continue;
  const ns=(p:any)=>p?.ns?BigInt(p.ns):null,begin=ns(start.at)!,finish=ns(end.at)!;
  const rows=raw.filter(r=>r.taskId===start.taskId&&r.graphId===start.event.graphId&&ns(r.sent)!>=begin&&ns(r.returned)!<=finish&&r.sent?.ns&&r.returned?.ns).sort((a,b)=>Number(ns(a.sent)!-ns(b.sent)!));
  if(rows.length!==start.event.nodes.length)continue;let cursor=begin;
  for(const [i,row] of rows.entries()){const before=ns(row.sent)!-cursor,tail=i===rows.length-1?finish-ns(row.returned)!:0n;if(before<0n||tail<0n)continue;times.set(row.invocationId,Number(before+tail)/1e6);cursor=ns(row.returned)!;}
 }return times;
}
const same=(a:Map<string,number>,b:Map<string,number>)=>JSON.stringify([...a])===JSON.stringify([...b]);
const at=(n:number)=>({ns:String(n)});

test('#2 graphTimes: iteration, taskId and graphId that are null or undefined stay different keys, as before T9',()=>{
  // null start, an undefined end first in file order and the null end later: before T9 only the null end matches.
  const events=[{taskId:null,at:at(10),event:{iteration:null,graphId:null,nodes:['a','b'],status:'started'}},{at:at(40),event:{graphId:null,nodes:['a','b'],status:'completed'}},
    {taskId:null,at:at(90),event:{iteration:null,graphId:null,nodes:['a','b'],status:'completed'}},
    {taskId:'t',at:at(100),event:{iteration:1,graphId:'g',nodes:['a'],status:'started'}},{taskId:'t',at:at(150),event:{graphId:'g',nodes:['a'],status:'completed'}},{taskId:'t',at:at(190),event:{iteration:1,graphId:'g',nodes:['a'],status:'completed'}},
    {taskId:'t',at:at(200),event:{iteration:2,graphId:null,nodes:['a'],status:'started'}},{taskId:'t',at:at(260),event:{iteration:2,graphId:null,nodes:['a'],status:'completed'}}];
  const raw=[{taskId:null,graphId:null,invocationId:'n1',sent:at(20),returned:at(30)},{invocationId:'n2',sent:at(32),returned:at(38)},{taskId:null,graphId:null,invocationId:'n3',sent:at(50),returned:at(80)},
    {taskId:'t',graphId:'g',invocationId:'g1',sent:at(110),returned:at(120)},
    {taskId:'t',invocationId:'u',sent:at(205),returned:at(208)},{taskId:'t',graphId:null,invocationId:'p',sent:at(210),returned:at(250)}];
  const a=oldGraphTimes(events,raw),b=graphTimesFromRows(events,raw);
  assert(same(a,b),JSON.stringify({old:[...a],now:[...b]}));
  assert.deepEqual([...a].map(([k])=>k).sort(),['g1','n1','n3','p'],'the case exercises matched graphs with null keys');
  // 300 random inputs where each key is a value, null, undefined or absent
  const lcg=(seed:number)=>{let s=seed>>>0;return ()=>(s=(s*1664525+1013904223)>>>0)/2**32;};
  let nonEmpty=0;
  for(let seed=1;seed<=300;seed++){const rnd=lcg(seed),pick=(v:any)=>{const x=rnd();return x<.3?v:x<.55?null:x<.8?undefined:'ABSENT';},put=(o:any,k:string,v:any)=>{if(v!=='ABSENT')o[k]=v;return o;};
    const ev:any[]=[],rows:any[]=[];let t=100;
    for(let k=0;k<8;k++){const tid=pick('t'+(k%2)),it=pick(k%3),g=pick('g'),n=1+Math.floor(rnd()*2),nodes=Array.from({length:n},(_,i)=>'n'+i);
      ev.push(put({at:at(t),event:put({graphId:g,nodes,status:'started'},'iteration',it)},'taskId',tid));t+=2;
      for(let i=0;i<n+(rnd()<.3?1:0);i++){const sent=t,ret=t+1+Math.floor(rnd()*4);t=ret+1;rows.push(put(put({invocationId:`i${k}-${i}`,sent:at(sent),returned:at(ret)},'taskId',rnd()<.8?tid:pick('t0')),'graphId',rnd()<.8?g:pick('g')));}
      if(rnd()<.5){ev.push(put({at:at(t),event:put({graphId:g,nodes,status:'completed'},'iteration',rnd()<.5?it:pick(k%3))},'taskId',rnd()<.5?tid:pick('t0')));t+=1;}
      ev.push(put({at:at(t+2),event:put({graphId:g,nodes,status:'completed'},'iteration',it)},'taskId',tid));t+=4;}
    const x=oldGraphTimes(ev,rows),y=graphTimesFromRows(ev,rows);assert(same(x,y),'seed '+seed);if(x.size)nonEmpty++;}
  assert(nonEmpty>250,'random inputs must exercise matched graphs: '+nonEmpty);
});
