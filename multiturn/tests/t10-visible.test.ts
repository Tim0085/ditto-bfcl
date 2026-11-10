// T10, no scheduler lock, no containers: private use, unassigned code points, noncharacters, U+FFFC and U+1D159 are not
// visible in an authorization text (live.ts visibleCount); Chinese, Korean, other scripts, text with combining marks and
// emoji still are. confirm-fee.ts uses the same count: one child at a time with SEC1_PROBE_DEPTH=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,mkdtempSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {checkLiveRun,visibleCount} from '../src/ts/scheduler/live.ts';
import {ROOT,guard} from '../src/ts/scheduler/io.ts';
const u=(...cps:number[])=>String.fromCodePoint(...cps);
const hex=(s:string)=>[...s].map(c=>'U+'+c.codePointAt(0)!.toString(16).toUpperCase()).join(' ');
const INVISIBLE:[string,number[]][]=[['private use U+E000',[0xe000]],['private use U+F8FF',[0xf8ff]],['private use plane 15',[0xf0000]],['private use plane 16',[0x10fffd]],
  ['unassigned U+0378',[0x378]],['unassigned plane 4 U+40000',[0x40000]],['unassigned plane 14 U+E0080',[0xe0080]],
  ['noncharacter U+FFFF',[0xffff]],['noncharacter U+FFFE',[0xfffe]],['noncharacter U+FDD0',[0xfdd0]],['noncharacter U+FDEF',[0xfdef]],['noncharacter U+1FFFE',[0x1fffe]],['noncharacter U+10FFFF',[0x10ffff]],
  ['object replacement U+FFFC',[0xfffc]],['musical null notehead U+1D159',[0x1d159]]];
const VISIBLE=['同意','用户 11-08 同意阶段 4 运行',u(0xd55c,0xad6d),u(0x1100,0x1161,0x11a8,0x1100,0x1161),'e'+u(0x301)+'x',u(0x928,0x92e,0x938,0x94d,0x924,0x947),u(0xe2a,0xe27,0xe31,0xe2a,0xe14,0xe35),'ok','2a',
  u(0x2764,0xfe0f)+'x',u(0x1f600,0x1f600),u(0x1f468,0x200d,0x1f469,0x200d,0x1f467),u(0xfffd,0xfffd),'かな'];

test('visibleCount: the new invisible ranges count 0; earlier visible texts keep their count',()=>{
  for(const [label,cps] of INVISIBLE)assert.equal(visibleCount(u(...cps,...cps)),0,label);
  assert.equal(visibleCount(INVISIBLE.map(([,c])=>u(...c)).join('')+u(0x3164,0x2800,0x301,0xfe0f,0x200b)),0,'all together with the T9 C3 set');
  assert.equal(visibleCount('同意'),2);assert.equal(visibleCount(u(0xd55c,0xad6d)),2);assert.equal(visibleCount(u(0x1f600,0x1f600)),2);assert.equal(visibleCount('e'+u(0x301)+'x'),2);
  assert.equal(visibleCount(u(0x1f468,0x200d,0x1f469,0x200d,0x1f467)),3,'a family emoji keeps its three people; the joiners are not counted');
  assert.equal(visibleCount('x'+u(0xe000,0xfffc,0x1d159,0x378)),1);
});

test('checkLiveRun: texts made only of the new invisible characters are refused; real explanations pass',()=>{
  const h='b'.repeat(64),plan:any={hash:h},ok=(text:string)=>checkLiveRun(plan,{keyFile:'k',authorization:`live:${h} ${text}`});
  for(const text of VISIBLE)ok(text);
  for(const [label,cps] of INVISIBLE){assert.throws(()=>ok(u(...cps,...cps)),/explanation/,label);assert.throws(()=>ok('x'+u(...cps)),/explanation/,'one visible + '+label);}
});

test('confirm-fee.ts: the same characters are refused for --authorization and --user-text; Chinese accepted',()=>{
  const base=join(tmpdir(),'t10-visible');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'r-'));mkdirSync(join(root,'egress'),{recursive:true});writeFileSync(join(root,'plan.json'),'{}');
  writeFileSync(join(root,'egress','ledger.jsonl'),[{kind:'header'},{kind:'reserve',id:'ffffffff-1',configId:'x',caseId:'c1',taskId:'run/x/r1/c1',microUsd:100,microCny:500},{kind:'retain_failed',id:'ffffffff-1',heldMicroUsd:100,heldMicroCny:500}].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const run=(authorization:string,userText='确认未扣费')=>spawnSync(process.execPath,['--import',guard,'--experimental-transform-types',join(ROOT,'scripts','confirm-fee.ts'),'--root',root,'--request','ffffffff-1','--conclusion','not-charged','--user-text',userText,'--authorization',authorization],
    {cwd:ROOT,encoding:'utf8',windowsHide:true,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,TMP:process.env.TMP,OFFLINE_GUARD_REPORT_DIR:join(root,'guards'),SEC1_PROBE_DEPTH:'1'}});
  // U+FFFE/U+FFFF are left off the command line (Windows may not pass them through unchanged); the CLI is checked with
  // private use, unassigned, U+FDD0, U+FFFC and U+1D159, and the full set on visibleCount above.
  for(const cps of [[0xe000,0xe001],[0x378,0x379],[0xfdd0],[0xfffc],[0x1d159],[0xf0000]]){const text=u(...cps),r=run(text);assert.equal(r.status,2,'refused: '+hex(text)+' '+r.stderr.slice(-300));}
  assert.equal(run('用户 11-08 授权',u(0xe000)).status,2,'invisible user text refused too');
  assert(!existsSync(join(root,'scheduler','fee-confirmations.jsonl')),'nothing recorded for refused texts');
  const r=run('用户 11-08 对话授权');assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(join(root,'scheduler','fee-confirmations.jsonl'),'utf8').trim().split('\n').length,1);
});
