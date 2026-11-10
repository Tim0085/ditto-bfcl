// T9 C1, no scheduler lock, no containers: export additions.
// graphTimes equals the pre-T9 algorithm; resource totals are kept with coverage flags; fee confirmations
// are append-only and change only the export; live run roots export twice byte-identically and match
// docs/20 (only if the stage-2 run roots are present; they are read, never written).
import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync,appendFileSync,copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {scratch} from './t8a-helpers.ts';
import {graphTimesFromRows} from '../src/ts/scheduler/export-graph.ts';
import {resource} from '../src/ts/scheduler/export-resource.ts';
import {exportLedger,feeConfirmations} from '../src/ts/scheduler/export-ledger.ts';
import {inFlight,describe,Samples,roleOf} from '../src/ts/scheduler/export-detail.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {files,ROOT,guard} from '../src/ts/scheduler/io.ts';
import {jsonRows,fileHash} from '../src/ts/scheduler/export-stream.ts';
import {memUsageBytes} from '../src/ts/scheduler/host.ts';

// The pre-T9 export.ts graphTimes, copied verbatim (only the events argument replaces the file read).
function oldGraphTimes(events:any[],raw:any[]){const times=new Map<string,number>();
 for(const start of events.filter(e=>e.event?.status==='started')){const end=events.find(e=>e.taskId===start.taskId&&e.event.iteration===start.event.iteration&&e.event.status!=='started');if(!end)continue;
  const ns=(p:any)=>p?.ns?BigInt(p.ns):null,begin=ns(start.at)!,finish=ns(end.at)!;
  const rows=raw.filter(r=>r.taskId===start.taskId&&r.graphId===start.event.graphId&&ns(r.sent)!>=begin&&ns(r.returned)!<=finish&&r.sent?.ns&&r.returned?.ns).sort((a,b)=>Number(ns(a.sent)!-ns(b.sent)!));
  if(rows.length!==start.event.nodes.length)continue;let cursor=begin;
  for(const [i,row] of rows.entries()){const before=ns(row.sent)!-cursor,tail=i===rows.length-1?finish-ns(row.returned)!:0n;if(before<0n||tail<0n)continue;times.set(row.invocationId,Number(before+tail)/1e6);cursor=ns(row.returned)!;}
 }return times;
}
const same=(a:Map<string,number>,b:Map<string,number>)=>JSON.stringify([...a])===JSON.stringify([...b]);
function lcg(seed:number){let s=seed>>>0;return ()=>(s=(s*1664525+1013904223)>>>0)/2**32;}
function synthetic(seed:number){const rnd=lcg(seed),events:any[]=[],raw:any[]=[];let t=1000n;
 for(let task=0;task<4;task++)for(let it=0;it<6;it++){const graphId=['g-open','g-think','g-turn'][Math.floor(rnd()*3)],n=1+Math.floor(rnd()*3),taskId='task-'+task,begin=t;t+=BigInt(1+Math.floor(rnd()*5));
  const nodes=Array.from({length:n},(_,i)=>'n'+i);events.push({taskId,at:{ns:String(begin)},event:{iteration:it,graphId,nodes,status:'started'}});
  for(let i=0;i<n+(rnd()<.2?1:0);i++){const sent=t+BigInt(Math.floor(rnd()*4)),ret=sent+BigInt(Math.floor(rnd()*9))-(rnd()<.05?20n:0n);t=ret>t?ret:t+1n;raw.push({taskId,graphId:rnd()<.9?graphId:'other',invocationId:`i-${task}-${it}-${i}-${Math.floor(rnd()*3)}`,sent:rnd()<.95?{ns:String(sent)}:undefined,returned:{ns:String(ret)}});}
  t+=BigInt(Math.floor(rnd()*3));events.push({taskId,at:{ns:String(t)},event:{iteration:it,graphId,nodes,status:rnd()<.9?'completed':'failed'}});t+=1n;}
 // shuffle rows a little so file order is not time order
 for(let i=raw.length-1;i>0;i--)if(rnd()<.3){const j=Math.floor(rnd()*(i+1));[raw[i],raw[j]]=[raw[j],raw[i]];}
 return {events,raw};}

test('graphTimes: same result as the pre-T9 algorithm on 300 synthetic inputs, including damaged rows',()=>{
 let nonEmpty=0;for(let seed=1;seed<=300;seed++){const {events,raw}=synthetic(seed),a=oldGraphTimes(events,raw),b=graphTimesFromRows(events,raw);assert(same(a,b),'seed '+seed);if(a.size)nonEmpty++;}
 assert(nonEmpty>250,'synthetic inputs must exercise matched graphs');
});

// In the package the stage-2 roots are runs/live/*; an isolated copy points T9C1_LIVE_ROOT at the package's runs/live.
const live=['live-profile-002','live-pilot-001'].map(n=>resolve(process.env.T9C1_LIVE_ROOT??join(ROOT,'runs','live'),n));
// T9 C3: a missing stage-2 root fails the test (it used to be skipped silently).
const needLive=()=>{const gone=live.filter(p=>!existsSync(p));assert.deepEqual(gone,[],'stage-2 run roots not found: '+gone.join(', ')+'; in an isolated copy set T9C1_LIVE_ROOT to the package runs/live');};
test('graphTimes: same result as the pre-T9 algorithm on every stage-2 unit directory',()=>{
 needLive();let units=0,matched=0;for(const root of live)for(const p of files(join(root,'blocks')).filter(p=>/[\\/]graphs\.jsonl$/.test(p))){const dir=p.slice(0,-'graphs.jsonl'.length),events=Array.from(jsonRows(p)).filter(e=>!e.malformed),raw=Array.from(jsonRows(join(dir,'steps.jsonl')));
  const a=oldGraphTimes(events,raw),b=graphTimesFromRows(events,raw);assert(same(a,b),dir);units++;matched+=a.size;}
 assert(units>=32&&matched>1000,`units ${units}, matched ${matched}`);
});

function samples(dir:string,rows:any[]){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'resources.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return dir;}
const cg=(ms:number,cpuUs:number,rss:number,available=true)=>({kind:'cgroup',at:{wall:new Date(ms).toISOString()},cpuUs,rssBytes:rss,available});
test('resources: totals are integrated when samples exist; the pre-T9 rule survives as resourceSamplingOk',()=>{
 const base=scratch();
 // complete: same numbers and notes as before T9, flag true
 const ok=resource(samples(join(base,'ok'),[cg(1000,0,1e9),cg(1200,100000,1e9),cg(1400,200000,1e9)]),1000,1400,200,false);
 assert.equal(ok.cpuSeconds,.2);assert.equal(ok.gbSeconds,.4);assert.equal(ok.gibSeconds,.4*1e9/1024**3);assert.equal(ok.resourceSamplingOk,true);assert.equal(ok.resourceCoverage,1);assert.equal(ok.resourceMaxGapMs,200);assert.deepEqual(ok.missing,[]);
 // one unavailable sample in the middle: before T9 the whole block was null
 const hole=resource(samples(join(base,'hole'),[cg(1000,0,1e9),cg(1200,0,0,false),cg(1400,200000,1e9)]),1000,1400,200,false);
 assert.equal(hole.cpuSeconds,.2);assert.equal(hole.gbSeconds,.4);assert.equal(hole.resourceSamplingOk,false);assert.equal(hole.resourceUnavailableSamples,1);assert.equal(hole.resourceMaxGapMs,400);assert(hole.missing.includes('cgroup samples incomplete'));
 // tail gap above one interval: values kept, the old text kept, flag false, coverage below 1
 const tail=resource(samples(join(base,'tail'),[cg(1000,0,1e9),cg(1200,100000,1e9)]),1000,1700,200,false);
 assert.equal(tail.cpuSeconds,.1);assert.equal(tail.resourceSamplingOk,false);assert.equal(tail.resourceMaxGapMs,500);assert.equal(tail.resourceCoverage,200/700);assert.deepEqual(tail.missing,['resource window not fully covered; tail gap 500ms, allowed 200ms']);
 // legacy sampler: the user-approved 1000ms allowance is still the rule behind the flag, text unchanged
 const legacy=resource(samples(join(base,'legacy'),[cg(1000,0,1e9),cg(1200,100000,1e9)]),1000,1900,200,true);
 assert.equal(legacy.resourceSamplingOk,true);assert.deepEqual(legacy.missing,['resource tail gap 700ms <= user-authorized legacy limit 1000ms; totals cover observed samples only, no extrapolation']);
 // nothing to integrate: still null
 const one=resource(samples(join(base,'one'),[cg(1000,0,1e9)]),1000,1400,200,false);assert.equal(one.cpuSeconds,null);assert.equal(one.resourceSamplingOk,false);
});

test('fee confirmations: latest valid line wins, ledger only read, not-charged leaves the unknown hold',()=>{
 const root=scratch();mkdirSync(join(root,'egress'),{recursive:true});mkdirSync(join(root,'scheduler'),{recursive:true});
 const plan:any={jobs:[{key:'r1-b',round:1,caseIds:['c1'],units:[{configId:'x'}]}]};
 const ledger=[{kind:'header'},{kind:'reserve',id:'aaaaaaaa-1',configId:'x',caseId:'c1',taskId:'run/x/r1/c1',microUsd:100,microCny:500},{kind:'retain_failed',id:'aaaaaaaa-1',heldMicroUsd:100,heldMicroCny:500},
  {kind:'reserve',id:'aaaaaaaa-2',configId:'x',caseId:'c1',taskId:'run/x/r1/c1',microUsd:100,microCny:500},{kind:'settle',id:'aaaaaaaa-2',usage:{inputTokens:10,cachedInputTokens:4,outputTokens:3,reasoningTokens:1},microUsd:7},
  {kind:'reserve',id:'aaaaaaaa-3',configId:'x',caseId:'c1',taskId:'run/x/r1/c1',microUsd:100,microCny:500}];
 writeFileSync(join(root,'egress','ledger.jsonl'),ledger.map(r=>JSON.stringify(r)).join('\n')+'\n');
 let b=exportLedger(root,plan).buckets.get('r1-b/x')!;assert.equal(b.unknown,2);assert.equal(b.heldMicroCny,1000);assert.equal(b.reasoning,1);assert.equal(b.settledMicroUsd,7);
 const row=(id:string,conclusion:string,extra:any={})=>JSON.stringify({kind:'fee-confirmation',requestId:id,conclusion,userText:'确认没扣费',authorization:'user 11-07',at:'t',...extra})+'\n';
 appendFileSync(join(root,'scheduler','fee-confirmations.jsonl'),row('aaaaaaaa-1','charged',{chargedCny:.3})+row('aaaaaaaa-1','not-charged')+row('aaaaaaaa-3','charged')+'{bad\n');
 const fees=feeConfirmations(root);assert.deepEqual(fees.invalidLines,[3,4]);assert.equal(fees.byId.get('aaaaaaaa-1')!.conclusion,'not-charged');
 const e=exportLedger(root,plan,fees.byId);b=e.buckets.get('r1-b/x')!;assert.equal(b.unknown,1);assert.equal(b.confirmedFree,1);assert.equal(b.heldMicroCny,500);assert.deepEqual(e.appliedConfirmations,['aaaaaaaa-1']);
});

test('confirm-fee.ts appends one line, refuses settled requests and missing authorization, never writes the ledger',()=>{
 const root=scratch();mkdirSync(join(root,'egress'),{recursive:true});writeFileSync(join(root,'plan.json'),'{}');
 const ledger=[{kind:'header'},{kind:'reserve',id:'bbbbbbbb-1',configId:'x',caseId:'c1',taskId:'run/x/r1/c1',microUsd:100,microCny:500},{kind:'retain_failed',id:'bbbbbbbb-1',heldMicroUsd:100,heldMicroCny:500},
  {kind:'reserve',id:'bbbbbbbb-2',configId:'x',caseId:'c1',taskId:'run/x/r1/c1',microUsd:100,microCny:500},{kind:'settle',id:'bbbbbbbb-2',usage:{inputTokens:1,cachedInputTokens:0,outputTokens:1},microUsd:1}];
 writeFileSync(join(root,'egress','ledger.jsonl'),ledger.map(r=>JSON.stringify(r)).join('\n')+'\n');const before=fileHash(join(root,'egress','ledger.jsonl'));
 const run=(...args:string[])=>spawnSync(process.execPath,['--import',guard,'--experimental-transform-types',join(ROOT,'scripts','confirm-fee.ts'),'--root',root,...args],{cwd:ROOT,encoding:'utf8',windowsHide:true,
  env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,TMP:process.env.TMP,OFFLINE_GUARD_REPORT_DIR:join(root,'guards'),SEC1_PROBE_DEPTH:'1'}});
 assert.equal(run('--request','bbbbbbbb-2','--conclusion','not-charged','--user-text','x','--authorization','y').status,2,'settled request refused');
 {const r=run('--request','bbbbbbbb-1','--conclusion','not-charged','--user-text','x','--authorization','​ ');assert.equal(r.status,2,'invisible authorization refused: '+r.stderr+r.error);}
 assert.equal(run('--request','bbbbbbbb-1','--conclusion','charged','--user-text','x','--authorization','y').status,2,'charged needs an amount');
 const ok=run('--request','bbbbbbbb-1','--conclusion','not-charged','--user-text','确认未产生扣费','--authorization','用户 2026-11-07 对话授权');assert.equal(ok.status,0,ok.stderr);
 const lines=readFileSync(join(root,'scheduler','fee-confirmations.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));assert.equal(lines.length,1);assert.equal(lines[0].conclusion,'not-charged');assert.equal(lines[0].userText,'确认未产生扣费');assert.equal(lines[0].ledgerState,'retained');
 assert.equal(fileHash(join(root,'egress','ledger.jsonl')),before);
});

test('helpers: in-flight sweep, quantiles, process roles, docker memory text',()=>{
 assert.deepEqual(inFlight([0,10,5,15,20,30]),{requests:3,peakInFlight:2,meanInFlight:30/30,firstRequestAt:0,lastResponseAt:30});
 assert.deepEqual(inFlight([0,10,10,20]).peakInFlight,1,'an end and a start at the same instant do not overlap');
 const s=new Samples();for(const v of [1,2,3,4,null])s.push(v);const d=describe(s);assert.equal(d.samples,4);assert.equal(d.missing,1);assert.equal(d.p50,2.5);assert.equal(d.max,4);
 assert.equal(roleOf({role:'worker',workerId:'Infer-3'}),'Infer');assert.equal(roleOf({role:'main',command:'node src/ts/config-main.ts'}),'main');assert.equal(roleOf({role:'main',command:'/sbin/docker-init --'}),'init');assert.equal(roleOf({role:'python',command:'python3 -B /app/scripts/docker-entry.py'}),'entry');
 assert.equal(memUsageBytes('1.5GiB / 15.4GiB'),1.5*1024**3);assert.equal(memUsageBytes('n/a'),null);
});

test('stage-2 live roots: two exports are byte-identical and the totals match docs/20',()=>{
 needLive();const want:Record<string,{requests:number;correct:number;valley:number;unknown:number;held:number}>={'live-profile-002':{requests:469,correct:13,valley:.64,unknown:1,held:.589824},'live-pilot-001':{requests:808,correct:28,valley:.78,unknown:0,held:0}};
 for(const root of live){const out=scratch(),a=exportRun(root,join(out,'a'));exportRun(root,join(out,'b'));
  for(const p of files(join(out,'a')))assert(readFileSync(p).equals(readFileSync(p.replace(join(out,'a'),join(out,'b')))),p);
  const w=want[root.split(/[\\/]/).at(-1)!],sum=(k:string)=>a.summary.reduce((s:number,r:any)=>s+(r[k]??0),0);
  assert.equal(sum('requests'),w.requests);assert.equal(sum('correct'),w.correct);assert.equal(Math.round(sum('knownValleyCny')*100)/100,w.valley);assert.equal(sum('unknownRequests'),w.unknown);assert.equal(Math.round(sum('unknownHeldPeakCny')*1e6)/1e6,w.held);
  assert(a.taskRows.every((t:any)=>Array.isArray(t.requestBodyBytes)&&t.requestBodyBytes.every((n:any)=>n>0)),'live request bodies come from model-records');
  assert(a.taskRows.every((t:any)=>t.executionOutcome==='completed'&&t.taskStatus==='completed'));
  assert(a.summary.every((r:any)=>r.cpuSeconds!==null&&r.gibSeconds!==null&&typeof r.resourceSamplingOk==='boolean'));
  // T9 C3 #1: stage 2 has no fee confirmation, so the confirmed-charged column is blank (null, not 0) everywhere.
  assert(a.summary.every((r:any)=>r.confirmedChargedRequests===0&&r.confirmedChargedCny===null),'summary confirmedChargedCny null without charged confirmations');}
});
