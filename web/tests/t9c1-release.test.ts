// T9 C1, no scheduler lock, no containers: scripts/build-release.py file management.
// Documents carry only package-relative paths and the code version; exports stay out of the package; an
// existing target, partial directory or manifest is refused; a forbidden spelling in a document stops the
// build before the package is renamed into place; the manifest lists every package file with bytes and
// SHA-256; check-release.py passes. Uses the stage-2 run roots read-only when present (T9C1_LIVE_ROOT
// points an isolated copy at the package's runs/live), exporting into scratch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve,relative,sep} from 'node:path';
import {existsSync,readFileSync,mkdirSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {scratch} from './t8a-helpers.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {files,ROOT} from '../src/ts/scheduler/io.ts';

const PYTHON=process.env.T9C1_PYTHON??'E:/Anaconda3/python.exe';
const liveBase=resolve(process.env.T9C1_LIVE_ROOT??join(ROOT,'runs','live'));
const live=['live-profile-002','live-pilot-001'].map(n=>join(liveBase,n));
const packageRoot=resolve(liveBase,'..','..');
const CODE='0'.repeat(63)+'1';
const EXPORT_CMD='node --import ./scripts/egress-offline-guard.mjs --experimental-transform-types scripts/t8a.ts export --root {root} --output <输出目录>';
const FORBIDDEN=['F:/','F:\\','_tmp','release-draft','runs/offline/t9-'];
const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONDONTWRITEBYTECODE:'1',SEC1_PROBE_DEPTH:'1'};
const py=(script:string,args:string[])=>spawnSync(PYTHON,['-B',join(ROOT,'scripts',script),...args],{cwd:ROOT,encoding:'utf8',windowsHide:true,env});
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');

test('build-release.py: relative paths, code version, no exports, refusals, path self-check, manifest',()=>{
 // T9 C3: a missing stage-2 root fails the test (it used to be skipped silently).
 {const gone=live.filter(p=>!existsSync(p));assert.deepEqual(gone,[],'stage-2 run roots not found: '+gone.join(', ')+'; in an isolated copy set T9C1_LIVE_ROOT to the package runs/live');}
 const work=scratch(),exports=live.map((root,i)=>{const out=join(work,'export-'+i);exportRun(root,out);return out;});
 const stages=(labels:string[])=>labels.flatMap((label,i)=>['--stage',`${label}=${exports[i]}=${live[i]}`]);
 const build=(out:string,manifest:string,labels=['2a 剖析','2b 小批'],extra:string[]=[])=>py('build-release.py',['--out',out,'--title','测试包','--package-root',packageRoot,'--code-version',CODE,'--export-command',EXPORT_CMD,'--manifest',manifest,...stages(labels),...extra]);
 const out=join(work,'drafts','pkg'),manifest=join(work,'drafts','manifest.json');mkdirSync(join(work,'drafts'));
 const r=build(out,manifest);assert.equal(r.status,0,r.stderr+r.stdout);
 assert(!existsSync(out+'.partial'),'partial directory renamed away');
 // Only finished products at the top level; no export file copied in.
 const all=files(out).map(p=>relative(out,p).split(sep).join('/'));
 assert.deepEqual([...new Set(all.map(p=>p.split('/')[0]))].sort(),['01_论文结果','02_实验设置','README.md']);
 assert(!all.some(p=>/(^|\/)(metadata|summary|tasks|blocks)\.json$|\.jsonl$/.test(p)),'no export files in the package: '+all.join(','));
 // Documents: no forbidden spelling, run roots and export commands relative to the package root, code version present.
 for(const doc of ['README.md','02_实验设置/实验记录阅读说明.md','02_实验设置/数据字典.md']){const text=readFileSync(join(out,doc),'utf8');for(const f of FORBIDDEN)assert(!text.toLowerCase().includes(f.toLowerCase()),doc+' contains '+f);}
 const readme=readFileSync(join(out,'README.md'),'utf8'),guide=readFileSync(join(out,'02_实验设置','实验记录阅读说明.md'),'utf8');
 for(const n of ['live-profile-002','live-pilot-001']){assert(readme.includes('`runs/live/'+n+'/`'),'README run root '+n);assert(readme.includes('--root runs/live/'+n+' --output'),'README export command '+n);assert(guide.includes('runs/live/'+n+'/'),'guide tree '+n);}
 assert(guide.includes('runs/live/live-pilot-001/egress/ledger.jsonl'),'ledger path from the package root');
 assert(readme.includes(CODE),'code version in README');assert(readme.includes('scripts/build-release.py'),'script in README');
 // Manifest: every package file, bytes and SHA-256, paths relative to the package root.
 const m=JSON.parse(readFileSync(manifest,'utf8'));assert.equal(m.codeVersion,CODE);assert.equal(m.files,all.length);
 assert.deepEqual(m.rows.map((x:any)=>x.path),[...all].sort((a,b)=>a<b?-1:a>b?1:0));
 for(const x of m.rows){const p=join(out,...x.path.split('/'));assert.equal(x.bytes,statSync(p).size,x.path);assert.equal(x.sha256,sha(p),x.path);}
 const c=py('check-release.py',[out,manifest]);assert.equal(c.status,0,c.stdout+c.stderr);
 const report=JSON.parse(c.stdout);assert.equal(report.problemCount,0);assert.deepEqual(report.forbiddenPaths,[]);assert.deepEqual(report.manifest.mismatches,[]);
 // T9 C3 #1: main results and costs carry 已确认实付（元）; stage 2 has no charged confirmation, so the column is blank in every row.
 const csvRow=(l:string)=>{const cells:string[]=[];let cur='',quoted=false;for(let k=0;k<l.length;k++){const ch=l[k];if(quoted){if(ch==='"'){if(l[k+1]==='"'){cur+='"';k++;}else quoted=false;}else cur+=ch;}else if(ch==='"')quoted=true;else if(ch===','){cells.push(cur);cur='';}else cur+=ch;}cells.push(cur);return cells;};
 for(const sheet of ['主结果','费用与用量']){const rows=readFileSync(join(out,'01_论文结果','CSV',sheet+'.csv'),'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(csvRow);
  const i=rows[0].indexOf('已确认实付（元）');assert(i>=0,sheet+' has 已确认实付（元）');assert(rows.length>2&&rows.slice(1).every(r=>r[i]===''),sheet+' 已确认实付 blank');}
 {const dict=readFileSync(join(out,'02_实验设置','数据字典.md'),'utf8');assert.match(dict,/`confirmedChargedCny` \| 已确认实付 \| 元 \| [^|]*不分谷价、峰价/);}
 // Refusals: existing target, existing manifest, existing partial directory; nothing is overwritten.
 const before=sha(join(out,'01_论文结果','结果汇总.xlsx'));
 assert.notEqual(build(out,join(work,'drafts','m2.json')).status,0,'existing target refused');
 assert.notEqual(build(join(work,'drafts','pkg2'),manifest).status,0,'existing manifest refused');
 mkdirSync(join(work,'drafts','pkg3.partial'));assert.notEqual(build(join(work,'drafts','pkg3'),join(work,'drafts','m3.json')).status,0,'existing partial refused');
 assert.equal(sha(join(out,'01_论文结果','结果汇总.xlsx')),before);assert(!existsSync(join(work,'drafts','m2.json')));
 // Arguments that would put an absolute path into the documents are refused before anything is written.
 assert.notEqual(py('build-release.py',['--out',join(work,'drafts','pkg4'),'--title','x','--package-root',packageRoot,'--code-version',CODE,'--export-command','node x.ts --root {root} --output F:/x','--manifest',join(work,'drafts','m4.json'),...stages(['2a','2b'])]).status,0,'absolute export command refused');
 assert(!existsSync(join(work,'drafts','pkg4'))&&!existsSync(join(work,'drafts','pkg4.partial')));
 // A forbidden spelling that reaches a document (here through a stage label) stops the build: exit 3,
 // the package is not renamed into place and no manifest is written.
 const bad=build(join(work,'drafts','pkg5'),join(work,'drafts','m5.json'),['2a _tmp','2b 小批']);
 assert.equal(bad.status,3,bad.stdout+bad.stderr);assert.match(bad.stdout,/pathSelfCheck.*failed/);
 assert(!existsSync(join(work,'drafts','pkg5')),'not renamed');assert(!existsSync(join(work,'drafts','m5.json')),'no manifest');
 // Run roots outside --package-root are refused.
 assert.notEqual(py('build-release.py',['--out',join(work,'drafts','pkg6'),'--title','x','--package-root',join(packageRoot,'docs'),'--code-version',CODE,'--export-command',EXPORT_CMD,'--manifest',join(work,'drafts','m6.json'),...stages(['2a','2b'])]).status,0,'run root outside the package refused');
});
