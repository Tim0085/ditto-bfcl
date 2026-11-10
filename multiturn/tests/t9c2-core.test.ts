// T9 C2, no Docker and no scheduler lock: key redaction, the old server.ts --live entry, --key-file values, the
// egressLeftRunning check, the stricter freezing of a real stage, and the authorization text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {mkdirSync,mkdtempSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {keyRedactor,redactParsed} from '../src/ts/egress/backends/live.ts';
import {generate,freeze,type StageConfig} from '../src/ts/scheduler/plan.ts';
import {checkLiveRun} from '../src/ts/scheduler/live.ts';
import {egressLeftAlive} from '../src/ts/scheduler/egress.ts';
import {json,env,ROOT,read} from '../src/ts/scheduler/io.ts';
import {liveStage} from './t9-live-helpers.ts';
const scratch=()=>{const base=join(tmpdir(),'t9c2-core');mkdirSync(base,{recursive:true});return mkdtempSync(join(base,'r-'));};
const imageId='sha256:'+'0'.repeat(64);
const filled=(change:(s:any)=>void=()=>{})=>liveStage('t9c2-core','dev',['direct-c1'],['multi_turn_base_50'],x=>{(x.launcher as any).imageId=imageId;change(x);}) as StageConfig;
const cli=(args:string[])=>{const r=spawnSync(process.execPath,['--experimental-transform-types',...args],{cwd:ROOT,encoding:'utf8',windowsHide:true,env:env(join(scratch(),'guards'))});return {code:r.status,text:String(r.stdout)+String(r.stderr)};};

test('item 1: escaped and encoded copies of the key are redacted after parsing, everything else is untouched',()=>{
  const key='FAKEKEY-'+randomBytes(32).toString('hex'),redact=keyRedactor(key);
  const pct=[...Buffer.from(key)].map(b=>'%'+b.toString(16).padStart(2,'0')).join('');
  const b64=(prefix:string)=>Buffer.from(prefix+key+' tail').toString('base64');
  const wire=JSON.stringify({a:'@@'}).replace('@@','\\u0046'+key.slice(1));            // one escaped character
  const parsed=redactParsed(JSON.parse(wire),redact) as any;assert.equal(parsed.a,'[REDACTED]');
  for(const text of [key,encodeURIComponent(key),pct,pct.toUpperCase(),pct.slice(0,30).toUpperCase()+pct.slice(30),b64(''),b64('x'),b64('xy'),b64('Bearer '),Buffer.from(key).toString('base64url')]){
    const out=redact('before '+text+' after');assert.ok(!out.includes(key),text);assert.match(out,/\[REDACTED\]/,text);
  }
  // key names, nested arrays, tool arguments that are JSON text
  const reply=redactParsed({[key]:1,list:[{deep:[key]}],args:JSON.stringify({a:key})},redact) as any;
  assert.deepEqual(Object.keys(reply),['[REDACTED]','list','args']);assert.equal(reply.list[0].deep[0],'[REDACTED]');assert.ok(!reply.args.includes(key));
  // a reply without the key keeps its objects and order as they are
  const clean={id:'x',choices:[{message:{content:'hello',tool_calls:[{function:{arguments:'{"a":1}'}}]}}],usage:{prompt_tokens:1}};
  const copy=structuredClone(clean);assert.equal(redactParsed(copy,redact),copy);assert.deepEqual(copy,clean);
  assert.equal(JSON.stringify(redactParsed(structuredClone(clean),redact)),JSON.stringify(clean));
  // known limits, written in the manual: changed case and truncation are not recognized
  assert.ok(redact(key.toUpperCase()).includes(key.toUpperCase()));assert.ok(redact(key.slice(0,40)).includes(key.slice(0,40)));
  // no key (fixtures/replay never reach this backend; the test URL has none): identity
  assert.equal(keyRedactor('')('anything'),'anything');
});

test('item 2: the old server.ts entry refuses --live and names the real entry',()=>{
  const dir=scratch(),r=cli(['src/ts/egress/server.ts','--live','--backend','live','--config',join(dir,'none.json'),'--output',join(dir,'out')]);
  assert.notEqual(r.code,0);assert.match(r.text,/server\.ts 不接受 --live/);assert.match(r.text,/t8a\.ts run --live/);assert.ok(!existsSync(join(dir,'out')));
});

test('item 3: --key-file that is empty or names no file is refused before any record or lock, without echoing it',()=>{
  const root=scratch(),plan=freeze(filled(),root),auth=`live:${plan.hash} c2 test`,dir=scratch(),pasted='FAKEKEY-'+randomBytes(32).toString('hex');
  for(const value of ['','   ',join(dir,'no-such.keys'),dir,pasted]){
    const r=cli(['scripts/t8a.ts','run','--root',root,'--live','--key-file',value,'--live-authorization',auth]);
    assert.notEqual(r.code,0,JSON.stringify(value));assert.match(r.text,/密钥文件路径不存在或为空/);
    if(value.trim())assert.ok(!r.text.includes(value),'value echoed: '+value);
    assert.ok(!existsSync(join(root,'scheduler')),'scheduler directory written for '+JSON.stringify(value));
  }
  // the plan's own checks keep their messages and come first, even with a missing key file
  const wrong=cli(['scripts/t8a.ts','run','--root',root,'--live','--key-file',join(dir,'no-such.keys'),'--live-authorization','live:'+'1'.repeat(64)+' x']);
  assert.match(wrong.text,/full hash/);
  // an offline plan with --live is still refused with its own message
  const off=scratch();const s:any=read(join(ROOT,'config/stages/pilot.json'));s.runId='t9c2-off';s.launcher={kind:'local-process'};s.configs=[s.configs.find((c:any)=>c.id==='direct-c1')??s.configs[0]];s.batches=[{id:'b',configs:[s.configs[0].id],caseIds:['multi_turn_base_50']}];delete s.targetedSplit;
  const offPlan=freeze(s,off),key=join(dir,'real.keys');writeFileSync(key,'BFCL_API_KEY=x\n');
  const r=cli(['scripts/t8a.ts','run','--root',off,'--live','--key-file',key,'--live-authorization',`live:${offPlan.hash} x`]);assert.match(r.text,/offline plan must run without --live/);
});

test('item 8: egressLeftRunning needs control.json naming a live process created no later than its startedAt',()=>{
  const root=scratch(),shell=join(root,'scheduler','egress');mkdirSync(shell,{recursive:true});
  const control=(pid:number,startedAt:string)=>json(join(shell,'control.json'),{host:'127.0.0.1',port:9,identity:'x/egress',pid,token:'0'.repeat(64),startedAt});
  json(join(shell,'pid.json'),{pid:process.pid,at:new Date().toISOString()},true);
  assert.equal(egressLeftAlive(root),false,'pid.json alone never sets the marker');
  control(process.pid,new Date(Date.now()+60000).toISOString());assert.equal(egressLeftAlive(root),true,'this process, created before startedAt');
  control(process.pid,new Date(Date.now()-24*3600*1000).toISOString());assert.equal(egressLeftAlive(root),false,'a live process created after startedAt is not this egress');
  control(process.pid,'not a date');assert.equal(egressLeftAlive(root),false);
  control(4194301,new Date(Date.now()+60000).toISOString());assert.equal(egressLeftAlive(root),false,'dead pid');
  control(process.pid,new Date(Date.now()+60000).toISOString());json(join(shell,'exit.json'),{code:0},true);assert.equal(egressLeftAlive(root),false,'exit record');
});

test('item 9: a real stage freezes only with numbers the ledger and the export accept',()=>{
  generate(filled());
  const refuse:[string,(s:any)=>void,RegExp][]=[
    ['referenceCny 1e308',s=>{s.egress.settings.budget.referenceCny=1e308;},/referenceCny x 1e6/],
    ['referenceCny 9e15',s=>{s.egress.settings.budget.referenceCny=9e15;},/referenceCny x 1e6/],
    ['referenceCny 1e-12',s=>{s.egress.settings.budget.referenceCny=1e-12;},/referenceCny x 1e6/],
    ['referenceUsd 1e308',s=>{s.egress.settings.budget.referenceUsd=1e308;},/referenceUsd x 1e6/],
    ['referenceUsd 1e-7',s=>{s.egress.settings.budget.referenceUsd=1e-7;},/referenceUsd x 1e6/],
    ['extra peak key',s=>{s.egress.settings.budget.peakCnyPerMillion.extra=1;},/exactly cachedInput/],
    ['cached > uncached',s=>{s.egress.settings.budget.peakCnyPerMillion.cachedInput=5;s.prices.peak.cachedInput=5;},/no larger than uncachedInput/],
    ['prices.peak differs',s=>{s.prices.peak.output=800;},/prices\.peak equal/],
    ['prices.peak extra key',s=>{s.prices.peak.extra=1;},/prices\.peak equal/],
    ['referencePrice 0',s=>{s.egress.settings.model.referencePrice.inputPerMillion=0;},/referencePrice|金/],
    ['referencePrice Infinity',s=>{s.egress.settings.model.referencePrice.outputPerMillion=Infinity;},/referencePrice|金/],
  ];
  for(const [label,change,message] of refuse)assert.throws(()=>generate(filled(change)),message,label);
  // edges that are allowed: exactly 1 micro unit, cached equal to uncached, a large but safe limit
  generate(filled(s=>{s.egress.settings.budget.referenceCny=1e-6;s.egress.settings.budget.referenceUsd=1e-6;}));
  generate(filled(s=>{s.egress.settings.budget.peakCnyPerMillion.cachedInput=2;s.prices.peak.cachedInput=2;}));
  generate(filled(s=>{s.egress.settings.budget.referenceCny=9e9;}));
});

test('item 10: a real authorization needs at least 2 visible characters besides the hash',()=>{
  const plan=generate(filled()),h=plan.hash,ok=(text:string)=>checkLiveRun(plan,{keyFile:'k',authorization:text});
  for(const text of [`live:${h} ok`,`live:${h} 同意`,`同意 live:${h}`,`live:${h} 2a`])ok(text);
  for(const text of [`live:${h} .`,`live:${h} ​​`,`live:${h} ​x​`,`live:${h} ﻿­‍⁠`,`live:${h}　　`,`live:${h} ‎‏x`])
    assert.throws(()=>ok(text),/explanation/,JSON.stringify(text));
});
