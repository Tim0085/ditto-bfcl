// T9 C3, no Docker and no scheduler lock: nested escaped keys in parsed replies (#5) and the visible-character count of
// authorization texts (#7). The confirm-fee part starts the script as a child with SEC1_PROBE_DEPTH=1, one at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,mkdtempSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {keyRedactor,redactParsed} from '../src/ts/egress/backends/live.ts';
import {checkLiveRun,visibleCount} from '../src/ts/scheduler/live.ts';
import {ROOT,guard} from '../src/ts/scheduler/io.ts';
const scratch=()=>{const base=join(tmpdir(),'t9c3-core');mkdirSync(base,{recursive:true});return mkdtempSync(join(base,'r-'));};
const u=(...cps:number[])=>String.fromCodePoint(...cps);

test('#5 a key escaped inside JSON text (tool arguments) is redacted; clean replies are untouched',()=>{
  const key='FAKEKEY-'+randomBytes(32).toString('hex'),redact=keyRedactor(key),esc='\\u0046'+key.slice(1);
  // leak test: parse nested JSON text up to 8 layers
  const deep=(v:any,d=0):boolean=>{if(typeof v==='string'){if(v.includes(key))return true;const t=v.trim();if(d<8&&/^[[{"]/.test(t)){try{return deep(JSON.parse(t),d+1);}catch{}}return false;}
    if(Array.isArray(v))return v.some(x=>deep(x,d));if(v&&typeof v==='object')return Object.entries(v).some(([k,x])=>k.includes(key)||deep(x,d));return false;};
  const reply=(args:string)=>({id:'x',choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'c1',type:'function',function:{name:'ls',arguments:args}}]}}]});
  // the C2 review matrix row tool-args-escaped-inner-json, as the egress sees it after JSON.parse of the reply
  const wire=JSON.stringify(reply('@@')).replace('"@@"',JSON.stringify('{"a":"'+esc+'"}'));
  for(const [label,input] of [['matrix row',JSON.parse(wire)],['two layers',reply(JSON.stringify({outer:'{"a":"'+esc+'"}'}))],['escaped key name',reply('{"'+esc+'":1}')],
    ['JSON string literal',{v:'"'+esc+'"'}],['array text',{v:'["x","'+esc+'"]'}],['plain key',reply(JSON.stringify({a:key}))]] as [string,any][]){
    assert(deep(input),label+': input holds the key');const out=redactParsed(input,redact);assert(!deep(out),label+': key left');assert.match(JSON.stringify(out),/\[REDACTED\]/,label);
  }
  // the redacted inner text is still JSON with the same structure
  const out:any=redactParsed(JSON.parse(wire),redact);assert.deepEqual(JSON.parse(out.choices[0].message.tool_calls[0].function.arguments),{a:'[REDACTED]'});
  // known limit, written in the manual: more than 4 nested layers are not opened
  let t='{"a":"'+esc+'"}';for(let i=0;i<4;i++)t=JSON.stringify({n:t});assert(deep(redactParsed({v:t},redact)),'five layers: beyond the limit');
  // without the key nothing changes: same objects, inner JSON text kept byte for byte (spacing, escapes)
  const clean={id:'x',choices:[{message:{content:'hello { not json',tool_calls:[{function:{arguments:'{ "a" : 1,\n "b":"\\u0041" }'}},{function:{arguments:'[1, 2]'}}]}}],extra:'"quoted"',n:3};
  const copy=structuredClone(clean);assert.equal(redactParsed(copy,redact),copy);assert.equal(JSON.stringify(copy),JSON.stringify(clean));
  // what T9 C2 recognized is still recognized
  for(const text of [key,encodeURIComponent(key),Buffer.from(key).toString('base64'),Buffer.from('x'+key).toString('base64'),Buffer.from(key).toString('base64url')])assert(!String(redactParsed('a '+text+' b',redact)).includes(text),text.slice(0,12));
  assert.equal(keyRedactor('')('anything'),'anything');
});

test('#7 invisible fillers, Braille blank, combining marks and variation selectors are not visible; Chinese still is',()=>{
  const h='a'.repeat(64),plan:any={hash:h},ok=(text:string)=>checkLiveRun(plan,{keyFile:'k',authorization:`live:${h} ${text}`});
  for(const text of ['同意','用户 11-08 同意阶段 3 运行','ok','2a',u(0xd55c,0xad6d),'e'+u(0x301)+'x',u(0x2764,0xfe0f)+'x'])ok(text);
  for(const [label,text] of [['U+115F',u(0x115f,0x115f)],['U+1160',u(0x1160,0x1160)],['U+3164',u(0x3164,0x3164)],['U+FFA0',u(0xffa0,0xffa0)],['U+2800',u(0x2800,0x2800)],
    ['combining',u(0x301,0x20d0,0x489)],['VS1-16',u(0xfe00,0xfe0f)],['VS17-256',u(0xe0100,0xe01ef)],['one visible + fillers','x'+u(0x3164,0x2800,0xfe0f)],['U+2065',u(0x2065,0x2065)],
    ['zero width',u(0x200b,0x200b)],['dot','.'],['ideographic space',u(0x3000,0x3000)]] as [string,string][])
    assert.throws(()=>ok(text),/explanation/,label);
  assert.equal(visibleCount('同意'),2);assert.equal(visibleCount(u(0x3164,0x2800,0x115f,0x1160,0xffa0,0x301,0xfe0f,0xe0100,0x200b,0xfeff,0x2028,0x2065)),0);
});

test('#7 confirm-fee.ts uses the same count: invisible-only authorization refused, Chinese accepted',()=>{
  const root=scratch();mkdirSync(join(root,'egress'),{recursive:true});writeFileSync(join(root,'plan.json'),'{}');
  writeFileSync(join(root,'egress','ledger.jsonl'),[{kind:'header'},{kind:'reserve',id:'eeeeeeee-1',configId:'x',caseId:'c1',taskId:'run/x/r1/c1',microUsd:100,microCny:500},{kind:'retain_failed',id:'eeeeeeee-1',heldMicroUsd:100,heldMicroCny:500}].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const run=(authorization:string,userText='确认未扣费')=>spawnSync(process.execPath,['--import',guard,'--experimental-transform-types',join(ROOT,'scripts','confirm-fee.ts'),'--root',root,'--request','eeeeeeee-1','--conclusion','not-charged','--user-text',userText,'--authorization',authorization],
    {cwd:ROOT,encoding:'utf8',windowsHide:true,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,TMP:process.env.TMP,OFFLINE_GUARD_REPORT_DIR:join(root,'guards'),SEC1_PROBE_DEPTH:'1'}});
  for(const text of [u(0x3164,0x3164),u(0x2800),u(0x301),u(0xfe0f),u(0xe0100)]){const r=run(text);assert.equal(r.status,2,'refused: '+[...text].map(c=>c.codePointAt(0)!.toString(16)).join(' '));}
  assert.equal(run('用户 11-08 授权',u(0x3164)).status,2,'invisible user text refused too');
  assert(!existsSync(join(root,'scheduler','fee-confirmations.jsonl')),'nothing recorded for refused texts');
  const r=run('用户 11-08 对话授权');assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(join(root,'scheduler','fee-confirmations.jsonl'),'utf8').trim().split('\n').length,1);
});
