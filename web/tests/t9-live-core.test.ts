// T9 segment B, no Docker and no scheduler lock: freezing rules, the refusals of the real command line, stage templates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {mkdirSync,mkdtempSync,readFileSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {generate,freeze,matrix,type StageConfig,type Plan} from '../src/ts/scheduler/plan.ts';
import {checkLiveRun,recordLiveRun} from '../src/ts/scheduler/live.ts';
import {read,json,env,ROOT,digest} from '../src/ts/scheduler/io.ts';
import {schedulerLock} from '../src/ts/scheduler/lock.ts';
import {liveStage} from './t9-live-helpers.ts';
const imageId='sha256:'+'0'.repeat(64),scratch=()=>{const base=join(tmpdir(),'t9-live-core');mkdirSync(base,{recursive:true});return mkdtempSync(join(base,'r-'));};
const filled=(change:(s:any)=>void=()=>{})=>{const s:any=liveStage('t9b-core','dev',['direct-c1'],['web_search_no_snippet_50'],x=>{(x.launcher as any).imageId=imageId;change(x);});return s as StageConfig;};
const cli=(args:string[])=>{const r=spawnSync(process.execPath,['--experimental-transform-types','scripts/t8a.ts',...args],{cwd:ROOT,encoding:'utf8',windowsHide:true,env:env(join(scratch(),'guards'))});return {code:r.status,text:String(r.stdout)+String(r.stderr)};};
test('a real stage with every limit freezes, and its numbers are in the plan hash',()=>{
  const plan=generate(filled());assert.equal(plan.stage.egress.mode,'live');assert.equal(plan.stage.egress.backend,'live');
  const other=generate(filled(s=>{s.egress.settings.budget.referenceCny=999;}));assert.notEqual(plan.hash,other.hash);
});
test('freezing refuses any missing or non-positive limit',()=>{
  const paths:[string,(s:any,v:any)=>void][]=[['referenceUsd',(s,v)=>{s.egress.settings.budget.referenceUsd=v;}],['referenceCny',(s,v)=>{s.egress.settings.budget.referenceCny=v;}],
    ['peakCnyPerMillion.cachedInput',(s,v)=>{s.egress.settings.budget.peakCnyPerMillion.cachedInput=v;}],['peakCnyPerMillion.uncachedInput',(s,v)=>{s.egress.settings.budget.peakCnyPerMillion.uncachedInput=v;}],['peakCnyPerMillion.output',(s,v)=>{s.egress.settings.budget.peakCnyPerMillion.output=v;}],
    ['maxRequests',(s,v)=>{s.egress.settings.budget.maxRequests=v;}],['perTaskRequests',(s,v)=>{s.egress.perTaskRequests=v;}],['dispatchPolicy.maxInFlight',(s,v)=>{s.egress.dispatchPolicy.maxInFlight=v;}],
    ['dispatchPolicy.requestsPerMinute',(s,v)=>{s.egress.dispatchPolicy.requestsPerMinute=v;}],['dispatchPolicy.minIntervalMs',(s,v)=>{s.egress.dispatchPolicy.minIntervalMs=v;}],['dispatchPolicy.maxCooldownMs',(s,v)=>{s.egress.dispatchPolicy.maxCooldownMs=v;}],
    ['prices.peak.output',(s,v)=>{s.prices.peak.output=v;}],['prices.valley.uncachedInput',(s,v)=>{s.prices.valley.uncachedInput=v;}]];
  for(const [name,set] of paths)for(const value of [null,undefined,0,-1,Number.NaN,Number.POSITIVE_INFINITY,'5'])assert.throws(()=>generate(filled(s=>set(s,value))),new RegExp('finite positive '+name.replace('.','\\.')),name+'='+String(value));
  assert.throws(()=>generate(filled(s=>{delete s.egress.settings.budget.peakCnyPerMillion;})),/peakCnyPerMillion/);
  assert.throws(()=>generate(filled(s=>{delete s.egress.dispatchPolicy;})),/dispatchPolicy/);
});
test('a real stage needs the docker launcher and live on both fields',()=>{
  assert.throws(()=>generate(filled(s=>{s.launcher={kind:'local-process'};})),/docker launcher/);assert.throws(()=>generate(filled(s=>{delete s.launcher;})),/docker launcher/);
  assert.throws(()=>generate(filled(s=>{s.egress.mode='offline-reference';})),/backend and mode both live/);assert.throws(()=>generate(filled(s=>{s.egress.backend='fixtures';})),/backend and mode both live/);
});
test('the authorization text must name this plan and explain itself',()=>{
  const plan=generate(filled()),hash=plan.hash,ok=(authorization:any)=>checkLiveRun(plan,{keyFile:'k',authorization});
  ok(`live:${hash} approved stage 2a`);ok(`approved stage 2a live:${hash}`);
  assert.throws(()=>checkLiveRun(plan,undefined),/needs --live/);assert.throws(()=>checkLiveRun(plan,{keyFile:' ',authorization:`live:${hash} ok`}),/--key-file/);assert.throws(()=>checkLiveRun(plan,{authorization:`live:${hash} ok`}),/--key-file/);
  assert.throws(()=>ok(`live:${hash}`),/explanation/);assert.throws(()=>ok(`live:${hash}   `),/explanation/);assert.throws(()=>ok('live:'+'0'.repeat(64)+' other plan'),/full hash/);
  assert.throws(()=>ok(`live:${hash.slice(0,20)} prefix`),/full hash/);assert.throws(()=>ok('no hash at all'),/full hash/);assert.throws(()=>ok(undefined),/full hash/);
  assert.throws(()=>ok(`live:${hash} live:${'0'.repeat(64)} two`),/full hash/);
});
test('the run record holds the limits, the text and the key path, and nothing from the key file',()=>{
  const root=scratch(),plan=generate(filled()),authorization=`live:${plan.hash} stage approved`;recordLiveRun(root,plan,{keyFile:'F:/somewhere/fake.keys',authorization});
  const directory=join(root,'scheduler','live-authorizations'),names=readdirSync(directory);assert.equal(names.length,1);const row=read(join(directory,names[0]));
  assert.deepEqual(Object.keys(row).sort(),['at','authorization','keyFile','limits','pid','planHash','runId']);assert.equal(row.planHash,plan.hash);assert.equal(row.authorization,authorization);assert.equal(row.keyFile,'F:/somewhere/fake.keys');
  assert.deepEqual(Object.keys(row.limits).sort(),['dispatchPolicy','maxInFlight','maxRequests','peakCnyPerMillion','perTaskRequests','referenceCny','referenceUsd','searchCny','searchDispatch','searchMaxRequests']);assert.equal(row.limits.referenceCny,1000);assert.equal(row.limits.maxInFlight,81);
  const {searchMaxRequests,searchCny,searchDispatch}=plan.stage.egress;
  assert.deepEqual({searchMaxRequests:row.limits.searchMaxRequests,searchCny:row.limits.searchCny,searchDispatch:row.limits.searchDispatch},{searchMaxRequests,searchCny,searchDispatch});
  console.log('frozen search authorization limits',JSON.stringify({searchMaxRequests,searchCny,searchDispatch}));
});
test('command line: flags go together and only on run',()=>{
  const root=scratch();
  for(const args of [['recover','--root',root,'--authorization','x','--live'],['interrupt-egress','--root',root,'--authorization','x','--key-file','k'],['run','--root',root,'--key-file','k'],['run','--root',root,'--live-authorization','x']]){const r=cli(args);assert.notEqual(r.code,0);assert.match(r.text,/go together, on run only/);}
});
test('command line: a real plan refuses a run without its three items, before taking any lock',()=>{
  const root=scratch(),plan=freeze(filled(),root),key=join(root,'never-opened.keys'),good=`live:${plan.hash} ok`;
  for(const [args,message] of [[['run','--root',root],/needs --live/],[['run','--root',root,'--live','--live-authorization',good],/--key-file is required/],[['run','--root',root,'--live','--key-file',key],/full hash/],[['run','--root',root,'--live','--key-file',key,'--live-authorization','live:'+'1'.repeat(64)+' wrong'],/full hash/],[['run','--root',root,'--live','--key-file',key,'--live-authorization',`live:${plan.hash}`],/explanation/]] as [string[],RegExp][]){const r=cli(args);assert.notEqual(r.code,0,args.join(' '));assert.match(r.text,message);}
  assert(!existsSync(join(root,'scheduler','live-authorizations')));
});
test('command line: --env-file is not an option; Node would open that file itself',()=>{
  const root=scratch(),key=join(root,'real.keys');writeFileSync(key,'NAME=value\n');const r=cli(['run','--root',root,'--live','--env-file',key]);assert.notEqual(r.code,0);assert.match(r.text,/Unknown option '--env-file'/);
});
test('recover and interrupt-egress on a real plan still need an explanation, not a key file',()=>{
  const root=scratch();freeze(filled(),root);for(const command of ['recover','interrupt-egress']){const r=cli([command,'--root',root,'--authorization','  ']);assert.notEqual(r.code,0);assert.match(r.text,/authorization is required/);}
});
const template=(name:string)=>read<any>(join(ROOT,'config/stages',name));
const cases=(s:any,b:any)=>b.caseIds.length;
test('stage templates: scale, layout and blanks',()=>{
  const profile=template('live-profile.json'),pilot=template('live-pilot.json'),slice=template('live-slice.json'),main=template('live-main.json');
  const runs=(s:any)=>s.rounds*s.batches.reduce((n:number,b:any)=>n+b.configs.length*cases(s,b),0);
  assert.equal(runs(profile),12);assert.deepEqual(profile.batches[0].configs,['uniform-8-c1']);assert.equal(runs(pilot),56);assert.equal(runs(slice),380);assert.equal(runs(main),1800);
  const prof=[65,62,60,87,90,13,53,73,16,49,68,21];
  assert(pilot.batches[0].caseIds.every((c:string)=>!prof.includes(Number(c.split('_').at(-1)))));
  assert.deepEqual(slice.batches[0].caseIds,template('t8c-slice-exp1-v2.json').batches[0].caseIds);assert.deepEqual(slice.batches[1].configs,['mono-8-c8-solo']);assert.equal(slice.batches[1].lanes,undefined);
  for(const s of [slice,main]){const lanes=s.batches[0].lanes;assert.equal(lanes.length,2);assert.equal(lanes[0][0].length,5);assert.equal(lanes[1][0].length,7);assert.equal(lanes[1][1].length,6);}
  for(const s of [pilot,slice,main])assert.match(s.targetedSplit,/^TARGETED_SPLIT_REQUIRED/);assert.equal(profile.targetedSplit,undefined);
  for(const s of [profile,pilot,slice,main]){
    const e=s.egress;assert.equal(e.backend,'live');assert.equal(e.mode,'live');assert.equal(e.settings.model.model,'deepseek-flash');assert.equal(e.settings.model.reasoningEffort,'high');assert.equal(s.launcher.kind,'docker');assert.equal(s.launcher.imageId,undefined);
    for(const v of [e.settings.budget.referenceUsd,e.settings.budget.referenceCny,e.settings.budget.maxRequests,...Object.values(e.settings.budget.peakCnyPerMillion),...Object.values(e.settings.model.referencePrice),...Object.values(s.prices.valley),...Object.values(s.prices.peak)])assert.equal(v,null);
    const offline=template('t8c-slice-exp1-v2.json');assert.deepEqual(s.stall,offline.stall);assert.equal(e.settings.model.timeoutMs,offline.egress.settings.model.timeoutMs);assert.deepEqual(e.retryPolicy,offline.egress.retryPolicy);
    assert.throws(()=>generate(s),/finite positive|Invalid|TARGETED|ENOENT/);
  }
});
test('stage templates: a copy with test numbers freezes; the files themselves stay blank',()=>{
  const targetedSplit=join(scratch(),'synthetic-web-targeted-split.json');
  json(targetedSplit,{status:'complete',synthetic:true,byCategory:{web_search_no_snippet:{copies:{Context:1,Infer:3,Interaction:3,Memory:1}}}});
  for(const name of ['live-profile.json','live-pilot.json','live-slice.json','live-main.json']){
    const before=readFileSync(join(ROOT,'config/stages',name)),s=template(name);s.launcher.imageId=imageId;s.launcher.tag='dev';if(s.targetedSplit)s.targetedSplit=targetedSplit;
    s.prices={source:'test numbers',date:'2026-11-07',valley:{cachedInput:.02,uncachedInput:1,output:4},peak:{cachedInput:.04,uncachedInput:2,output:8}};
    Object.assign(s.egress.settings.budget,{referenceUsd:8,referenceCny:4,maxRequests:10,peakCnyPerMillion:{cachedInput:.04,uncachedInput:2,output:8}});s.egress.settings.model.referencePrice={inputPerMillion:.3,outputPerMillion:1.2};
    Object.assign(s.egress,{searchMaxRequests:1000,searchCny:5,searchDispatch:{maxInFlight:4,requestsPerMinute:60}});
    const plan=generate(s);assert.equal(plan.jobs.reduce((n:number,j:any)=>n+j.units.reduce((m:number,u:any)=>m+u.caseIds.length,0),0),{'live-profile.json':12,'live-pilot.json':56,'live-slice.json':380,'live-main.json':1800}[name]);
    assert(readFileSync(join(ROOT,'config/stages',name)).equals(before));
  }
});
test('the launch rule reads the same scheduler lock as lock.ts; a copy that moves one must move both',()=>{
  assert(readFileSync(join(ROOT,'scripts/egress-live-launch.mjs'),'utf8').includes(`const schedulerLock = '${schedulerLock}';`));
});
test('the offline guard loads the launch rule but grants nothing outside the scheduler',()=>{
  const code=`import {liveEgressLaunch as l} from ${JSON.stringify(pathToFileURL(join(ROOT,'scripts/egress-live-launch.mjs')).href)};import {join} from 'node:path';const e=join(process.cwd(),'src/ts/scheduler/egress-shell.ts'),a=['--experimental-transform-types',e,'F:/x','F:/k'];console.log(JSON.stringify([l('spawn',process.execPath,a,{cwd:process.cwd()}),l('spawnSync',process.execPath,a,{cwd:process.cwd()}),l('spawn','node',a,{cwd:process.cwd()}),l('spawn',process.execPath,a.slice(0,3),{cwd:process.cwd()}),l('spawn',process.execPath,a,{cwd:process.cwd(),shell:true})]));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:ROOT,encoding:'utf8',windowsHide:true,env:env(join(scratch(),'g'))});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').find(l=>l.startsWith('['))!),[false,false,false,false,false]);
});
