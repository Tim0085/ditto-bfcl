// T10, no scheduler lock, no containers: scripts/build-release.py.
// "正式逐题" has 确认已扣费请求 and the data dictionary states 本次请求 = 已结算 + 确认免单 + 未知 + 确认已扣费; the
// "逐轮结果" reason names the stages actually packed (it said 阶段 2 for the stage-3 package); without --profile-report
// the "剖析分配" sheet is left out and listed in "没出的表" with the reason; with a report it is still there.
// Reads the stage-3 and stage-2a run roots read-only (T9C1_LIVE_ROOT points an isolated copy at the package runs/live),
// exports into scratch, one python child at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {scratch} from './t8a-helpers.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {ROOT} from '../src/ts/scheduler/io.ts';

const PYTHON=process.env.T9C1_PYTHON??'E:/Anaconda3/python.exe';
const liveBase=resolve(process.env.T9C1_LIVE_ROOT??join(ROOT,'runs','live'));
const packageRoot=resolve(liveBase,'..','..');
const CODE='0'.repeat(63)+'2';
const EXPORT_CMD='node --import ./scripts/egress-offline-guard.mjs --experimental-transform-types scripts/t8a.ts export --root {root} --output <输出目录>';
const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',SEC1_PROBE_DEPTH:'1'};
const py=(script:string,args:string[])=>spawnSync(PYTHON,['-B',join(ROOT,'scripts',script),...args],{cwd:ROOT,encoding:'utf8',windowsHide:true,env});
const csv=(path:string)=>readFileSync(path,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(l=>{const cells:string[]=[];let cur='',q=false;for(let k=0;k<l.length;k++){const ch=l[k];if(q){if(ch==='"'){if(l[k+1]==='"'){cur+='"';k++;}else q=false;}else cur+=ch;}else if(ch==='"')q=true;else if(ch===','){cells.push(cur);cur='';}else cur+=ch;}cells.push(cur);return cells;});

test('build-release.py: charged-request column, stage names in the reason, no empty profile sheet',()=>{
  const slice=join(liveBase,'live-slice-001'),profile=join(liveBase,'live-profile-002');
  {const gone=[slice,profile].filter(p=>!existsSync(p));assert.deepEqual(gone,[],'run roots not found: '+gone.join(', ')+'; in an isolated copy set T9C1_LIVE_ROOT to the package runs/live');}
  const work=scratch(),e3=join(work,'export-3'),e2=join(work,'export-2a');exportRun(slice,e3);exportRun(profile,e2);mkdirSync(join(work,'drafts'));
  const build=(name:string,stages:string[],extra:string[]=[])=>{const out=join(work,'drafts',name),r=py('build-release.py',['--out',out,'--title','测试包','--package-root',packageRoot,'--code-version',CODE,'--export-command',EXPORT_CMD,'--manifest',join(work,'drafts',name+'.json'),...stages.flatMap(s=>['--stage',s]),...extra]);
    assert.equal(r.status,0,r.stderr+r.stdout);const c=py('check-release.py',[out,join(work,'drafts',name+'.json')]);assert.equal(c.status,0,c.stdout+c.stderr);assert.equal(JSON.parse(c.stdout).problemCount,0);
    // every stage here ran one round: no per-round sheet, whether or not a report is given, and its reason comes first
    const info=JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!);assert(!('逐轮结果' in info.sheets),name+': no per-round sheet for one-round stages');assert.match(info.skipped[0],/^“逐轮结果”：/,name);
    return {out,info};};

  // stage 3, as the stage-3 package was built: no --profile-report
  const a=build('stage3',[`3 切片=${e3}=${slice}`]);
  assert.equal(a.info.skipped.length,2,JSON.stringify(a.info.skipped));
  assert.match(a.info.skipped[0],/^“逐轮结果”：本包的阶段（3 切片）每个配置只跑 1 轮/);assert(!a.info.skipped[0].includes('阶段 2'),'no stage-2 wording for a stage-3 package');
  assert.match(a.info.skipped[1],/^“剖析分配”：生成时没有给剖析依据报告（--profile-report），这张表不出$/);
  assert(!('剖析分配' in a.info.sheets),'no profile sheet');assert(!existsSync(join(a.out,'01_论文结果','CSV','剖析分配.csv')));
  const readme=readFileSync(join(a.out,'README.md'),'utf8');assert(readme.includes('**没出的表**：'+a.info.skipped.join('；')+'。'));assert(!readme.includes('| 剖析分配 |'));
  const tasks=csv(join(a.out,'01_论文结果','CSV','正式逐题.csv')),head=tasks[0],i=head.indexOf('确认已扣费请求（次）'),j=head.indexOf('未知请求（次）');
  assert(i>0&&i===j+1,'new column right after 未知请求: '+head.join('|'));assert.equal(tasks.length-1,380);assert(tasks.slice(1).every(r=>r[i]==='0'),'stage 3 has no charged confirmation: every row 0');
  const n=(r:string[],name:string)=>Number(r[head.indexOf(name)]);
  for(const r of tasks.slice(1))assert.equal(n(r,'本次请求（次）'),n(r,'已结算请求（次）')+n(r,'确认免单请求（次）')+n(r,'未知请求（次）')+n(r,'确认已扣费请求（次）'),'identity '+r.join('|').slice(0,80));
  const dict=readFileSync(join(a.out,'02_实验设置','数据字典.md'),'utf8');
  assert.match(dict,/`modelRequests` \| 本次请求 \| 次 \| [^|]*本次请求 = 已结算 \+ 确认免单 \+ 未知 \+ 确认已扣费/);assert.match(dict,/`confirmedChargedRequests` \| 确认已扣费请求 \| 次 \|/);

  // stage 2a with its split: without a report the sheet is left out and the reason points at targeted-split.json;
  // with a report (an empty byCategory is enough for the sheet to exist) it is there with 35 candidates per category.
  const b=build('2a-no-report',[`2a 剖析=${e2}=${profile}`]);
  assert(!('剖析分配' in b.info.sheets));assert.match(b.info.skipped.at(-1),/这张表不出；分法本身见运行根的 targeted-split\.json$/);assert.match(b.info.skipped[0],/本包的阶段（2a 剖析）/);
  const report=join(work,'report.json');writeFileSync(report,JSON.stringify({byCategory:{}}));
  const c=build('2a-report',[`2a 剖析=${e2}=${profile}`],['--profile-report',report]);
  assert.equal(c.info.sheets['剖析分配'],4*35);assert.equal(c.info.skipped.length,1,'only the per-round sheet is skipped');
});
