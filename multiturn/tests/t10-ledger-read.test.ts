// T10, no scheduler lock, no containers, no children: at unit exit the scheduler reads egress/ledger.jsonl and rate.jsonl
// a line at a time (records.ts recordInterrupted through io.ts eachLine) instead of as one string.
// #1 eachLine hands over exactly the rows lines() returns: empty lines, CRLF, a BOM, multi-byte characters and newlines on
//    every byte around the 1 MiB read boundary, a line longer than 1 MiB, an incomplete last line with and without
//    tolerateTail, a damaged line (both throw), a missing file.
// #2 recordInterrupted writes the same interruptions as the pre-T10 code (kept verbatim below) on 200 random ledgers.
// #3 recordInterrupted no longer reads either file whole (readFileSync is watched through syncBuiltinESMExports).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {scratch,stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {lines,eachLine,json,read,maybe,auxiliaryLines,files} from '../src/ts/scheduler/io.ts';
import {recordInterrupted} from '../src/ts/scheduler/records.ts';

const collect=(path:string,tolerateTail:boolean)=>{const rows:any[]=[];eachLine(path,tolerateTail,row=>rows.push(row));return rows;};
const outcome=(f:()=>any)=>{try{return {rows:f()};}catch(error){return {error:(error as Error).name};}};

test('#1 eachLine gives the rows lines() gives, including across the 1 MiB read boundary',()=>{
  const dir=scratch(),MiB=1<<20,cases:[string,string][]=[
    ['empty',''],['newline only','\n'],['complete','{"a":1}\n{"b":2}\n'],['no final newline','{"a":1}\n{"b":2}'],['incomplete tail','{"a":1}\n{"b":'],
    ['empty lines','\n\n{"a":1}\n\n\n{"b":"x"}\n\n'],['CRLF','{"a":1}\r\n{"b":2}\r\n'],['CR as last line','{"a":1}\n\r'],['BOM','﻿{"a":1}\n'],
    ['multi-byte','{"s":"中文 한국어 😀 é"}\n{"t":"\u{10FFFD}"}\n'],['damaged middle','{"a":1}\n{bad\n{"b":2}\n'],['damaged only line','{bad'],
    ['line over 1 MiB',JSON.stringify({s:'x'.repeat(MiB+12345)})+'\n{"z":1}\n'],['two pieces exactly',JSON.stringify({s:'y'.repeat(2*MiB-9)})+'\n']];
  // newline or a 3- or 4-byte character on every byte position around the first piece's end
  for(let d=0;d<10;d++){const fill='p'.repeat(MiB-16+d);cases.push(['boundary '+d,'{"p":"'+fill+'"}\n{"c":"中😀文"}\n{"n":'+d+'}\n'],['boundary tail '+d,'{"p":"'+fill+'"}\n{"c":"中😀']);}
  let compared=0;
  for(const [label,text] of cases){const path=join(dir,label.replace(/\W/g,'_')+'.jsonl');writeFileSync(path,text);
    for(const tolerate of [false,true]){const a=outcome(()=>lines(path,tolerate)),b=outcome(()=>collect(path,tolerate));assert.deepEqual(b,a,label+' tolerateTail='+tolerate);compared++;}}
  assert.deepEqual(collect(join(dir,'missing.jsonl'),true),[]);assert.deepEqual(lines(join(dir,'missing.jsonl'),true),[]);
  assert.deepEqual(outcome(()=>collect(join(dir,'damaged_middle.jsonl'),true)),{error:'SyntaxError'},'a damaged line still throws');
  assert.equal(compared,cases.length*2);
});

// ---------------------------------------------------------------- the pre-T10 recordInterrupted, verbatim
// (package src/ts/scheduler/records.ts:68-79 before T10; only the name differs)
function oldRecordInterrupted(attempt:any,cid:string,job:any,root:string,observedExit?:unknown){
  const dir=join(attempt.path,'output','configs',cid),seen=new Set<string>();
  for(const p of files(dir).filter(p=>p.endsWith('.jsonl')&&!p.endsWith('resources.jsonl')))for(const row of auxiliaryLines(p))if(typeof row.taskId==='string')seen.add(row.taskId.split('/').at(-1)!);
  // Recovery timestamps are conservative limiter bounds, never evidence that
  // the old request started in this attempt. Own steps and real new starts
  // still identify interruption; ledger liabilities are untouched.
  const exit:any=observedExit??maybe(join(attempt.path,'logs','exit.json'))??maybe(join(attempt.path,'collected.json'));
  const started=Date.parse(exit?.startedAt??maybe(join(attempt.path,'logs','control.json'))?.startedAt??''),ended=Date.parse(exit?.endedAt??'')||Infinity,sent=new Map(lines(join(root,'egress','rate.jsonl'),true).filter(r=>r.recovered!==true&&r.at<=ended).map(r=>[r.id,r.at]));
  for(const row of lines(join(root,'egress','ledger.jsonl'),true))if(row.configId===cid&&row.taskId?.includes(`/r${job.round}/`)&&(sent.get(row.id)??-Infinity)>=started)seen.add(row.caseId);
  const interrupted=attempt.caseIds.filter((caseId:string)=>seen.has(caseId)&&!existsSync(join(dir,'tasks',`${caseId}.r${job.round}.json`))&&!existsSync(join(dir,'failures',`${caseId}.r${job.round}.json`))).map((caseId:string)=>({caseId,configId:cid,round:job.round,disposition:'interrupted',failureType:'scheduler-unit-exit',source:'scheduler',taskId:`${read(join(root,'plan.json')).runId}/${cid}/r${job.round}/${caseId}`}));
  if(!existsSync(join(attempt.path,'interruptions.json')))json(join(attempt.path,'interruptions.json'),interrupted,true);
}

const lcg=(seed:number)=>{let s=seed>>>0;return ()=>(s=(s*1664525+1013904223)>>>0)/2**32;};
const CASES=['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_base_12','multi_turn_base_13'];
function randomRoot(seed:number){
  const rnd=lcg(seed),pick=<T>(a:T[])=>a[Math.floor(rnd()*a.length)],root=scratch(),s=stage('t10-read-'+seed,CASES);s.rounds=2;const p=freeze(s,root);
  const job=pick(p.jobs),cid=job.units[0].configId,start=Date.parse('2026-11-08T00:00:00Z'),configs=[cid,'mono-8-c8','uniform-8-c8'];
  const ledger:any[]=[{kind:'header',configId:'__global__'}],rate:any[]=[];
  for(let i=0;i<40;i++){const id='req-'+seed+'-'+i,config=rnd()<.6?cid:pick(configs),round=rnd()<.7?job.round:3-job.round,caseId=pick(CASES);
    ledger.push({kind:'reserve',id,configId:config,caseId,taskId:`${p.runId}/${config}/r${round}/${caseId}`,microUsd:100,microCny:500});
    if(rnd()<.7)ledger.push({kind:pick(['settle','retain_failed']),id,configId:config,microUsd:1});
    const at=start+Math.floor((rnd()-.4)*20000);if(rnd()<.85)rate.push({configId:config,id,at,...(rnd()<.15?{recovered:true}:{})});
    if(rnd()<.1)rate.push({configId:config,id,at:at+Math.floor((rnd()-.5)*20000)});}
  if(rnd()<.2)rate.push({configId:cid,id:'not-in-ledger',at:start+1});
  const tail=(rows:any[])=>rows.map(r=>JSON.stringify(r)+'\n').join('')+(rnd()<.3?'{"configId":"'+cid+'","id":"req-':'');
  mkdirSync(join(root,'egress'),{recursive:true});writeFileSync(join(root,'egress','ledger.jsonl'),tail(ledger));writeFileSync(join(root,'egress','rate.jsonl'),tail(rate));
  const caseIds=job.caseIds.filter(()=>rnd()<.8),exit={startedAt:rnd()<.9?new Date(start+Math.floor((rnd()-.5)*8000)).toISOString():undefined,endedAt:rnd()<.7?new Date(start+Math.floor(rnd()*12000)).toISOString():undefined};
  const attempt=(name:string)=>{const path=join(root,name),dir=join(path,'output','configs',cid);mkdirSync(dir,{recursive:true});return {path,dir,caseIds};};
  const a=attempt('attempt-old'),b=attempt('attempt-new'),ownStep=rnd()<.5;
  for(const x of [a,b]){const r=lcg(seed+7);for(const caseId of caseIds){const v=r();if(v<.2)json(join(x.dir,'tasks',`${caseId}.r${job.round}.json`),{caseId});else if(v<.3)json(join(x.dir,'failures',`${caseId}.r${job.round}.json`),{caseId});}
    if(ownStep)writeFileSync(join(x.dir,'steps.jsonl'),JSON.stringify({taskId:`${p.runId}/${cid}/r${job.round}/${caseIds[0]??'none'}`})+'\n');}
  return {root,job,cid,a,b,exit};
}

test('#2 recordInterrupted: same interruptions as the pre-T10 whole-file code on 200 random ledgers',()=>{
  let nonEmpty=0;
  for(let seed=1;seed<=200;seed++){const x=randomRoot(seed);
    oldRecordInterrupted(x.a,x.cid,x.job,x.root,x.exit);recordInterrupted(x.b,x.cid,x.job,x.root,x.exit);
    const before=read(join(x.a.path,'interruptions.json')),after=read(join(x.b.path,'interruptions.json'));
    assert.deepEqual(after,before,'seed '+seed);if(before.length)nonEmpty++;}
  assert(nonEmpty>=60,'random ledgers must produce interruptions: '+nonEmpty);
});

test('#3 unit exit no longer reads ledger.jsonl or rate.jsonl as one string',()=>{
  const root=scratch(),s=stage('t10-read-whole',['multi_turn_base_0']),p=freeze(s,root),job=p.jobs[0],cid=job.units[0].configId,caseId=job.caseIds[0],start=Date.parse('2026-11-08T00:00:00Z');
  mkdirSync(join(root,'egress'),{recursive:true});
  writeFileSync(join(root,'egress','ledger.jsonl'),JSON.stringify({kind:'reserve',id:'r1',configId:cid,caseId,taskId:`${p.runId}/${cid}/r1/${caseId}`,microUsd:1})+'\n');
  writeFileSync(join(root,'egress','rate.jsonl'),JSON.stringify({configId:cid,id:'r1',at:start+1000})+'\n');
  const a={path:join(root,'attempt'),caseIds:job.caseIds};mkdirSync(a.path,{recursive:true});
  const original=fs.readFileSync,whole:string[]=[];
  (fs as any).readFileSync=function(this:unknown,path:any,...rest:any[]){whole.push(String(path));return (original as any).call(this,path,...rest);};syncBuiltinESMExports();
  try{recordInterrupted(a,cid,job,root,{startedAt:new Date(start).toISOString(),endedAt:new Date(start+5000).toISOString()});}
  finally{(fs as any).readFileSync=original;syncBuiltinESMExports();}
  assert.deepEqual(whole.filter(p=>/(ledger|rate)\.jsonl$/.test(p)),[],'whole-file reads: '+whole.join(', '));
  assert.equal(read(join(a.path,'interruptions.json')).length,1,'the request started in this attempt still marks the task interrupted');
});
