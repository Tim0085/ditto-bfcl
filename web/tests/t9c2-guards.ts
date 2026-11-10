// T9 C2 item 5 (and the file rules of item 4): both guards against a ChildProcess built by hand, module.register and
// module.registerHooks; the live guard also against inspector.open, process._debugProcess, a hard link made before start,
// a renamed parent of the key folder, listing the key folder and glob. No Docker, no scheduler, no network.
// This driver loads no guard: the live guard refuses to load after the offline guard, so a guarded parent could not start a
// live-guarded child. It only writes files under its scratch directory and starts tests/t9c2-guard-child.mjs twice, one at a
// time, as `node tests/t9c2-guard-child.mjs` with a clean environment and no NODE_OPTIONS (the child is never loaded through
// NODE_OPTIONS or --import). The child starts at most 3 `node -e` grandchildren that only write a marker file.
// usage: node --experimental-transform-types tests/t9c2-guards.ts <scratch dir> <package root whose scripts/ are tested> [label]
// Exit 0 only when every expectation holds (run against the unchanged package it is expected to exit 1: that is the reproduction).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
if(Number(process.env.SEC1_PROBE_DEPTH??0)>=1){console.error('SEC1_PROBE_DEPTH>=1: not run nested');process.exit(2);}
const [scratchArg,rootArg,label='run']=process.argv.slice(2);
if(!scratchArg||!rootArg)throw new Error('usage: t9c2-guards.ts <scratch dir> <package root> [label]');
const scratch=resolve(scratchArg,label),root=resolve(rootArg),childFile=join(dirname(fileURLToPath(import.meta.url)),'t9c2-guard-child.mjs');
const result:any={root,label,modes:{}};
for(const mode of ['live','offline']){
  if(fs.existsSync('F:/Academic/Ditto/experiments/sec1/_tmp/coord/STOP')){result.STOPPED=mode;break;}
  const dir=join(scratch,mode),keyDir=join(dir,'parent','k'),keyFile=join(keyDir,'fake.keys'),key='FAKEKEY-'+randomBytes(32).toString('hex');
  fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(keyDir,{recursive:true});fs.mkdirSync(join(dir,'forbidden'),{recursive:true});
  fs.writeFileSync(keyFile,`BFCL_BASE_URL=https://127.0.0.1:9\nBFCL_API_KEY=${key}\n`);fs.writeFileSync(join(keyDir,'sibling.txt'),'sibling\n');
  fs.linkSync(keyFile,join(dir,'hardlink.keys'));
  const out=join(dir,'result.json');
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP,
    SEC1_PROBE_DEPTH:'0',T9C2_MODE:mode,T9C2_DIR:dir,T9C2_GUARDS:join(root,'scripts'),T9C2_COPY:root,T9C2_OUT:out,OFFLINE_GUARD_REPORT_DIR:join(dir,'guard-reports')};
  const child=spawn(process.execPath,[childFile],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);
  const code=await new Promise<number|null>(y=>child.once('close',y));
  const r=fs.existsSync(out)?JSON.parse(fs.readFileSync(out,'utf8')):{rows:[],missing:true};
  const row=(label:string)=>r.rows.find((x:any)=>x.label===label)??{outcome:'missing'};
  const expect:Record<string,(x:any)=>boolean>=mode==='live'?{
    'new ChildProcess().spawn':x=>x.outcome==='denied'&&x.marker===null,
    'module.register (loader thread)':x=>x.outcome==='denied'&&x.marker===null,
    'module.registerHooks (no-op hooks)':x=>x.outcome==='denied',
    'inspector.open on 127.0.0.1':x=>x.outcome==='denied',
    'process._debugProcess (pid that does not exist)':x=>x.outcome==='denied',
    'read the key through a hard link made before start':x=>x.outcome==='denied',
    'read the key under the renamed parent':x=>x.outcome==='denied',
    'read the sibling under the renamed parent':x=>x.outcome==='denied',
    'readdir of the key folder':x=>x.outcome==='denied',
    'globSync in the key folder':x=>x.outcome==='denied',
  }:{
    // the hand-built child still runs, but with the offline guard forced on, like every other child
    'new ChildProcess().spawn':x=>x.outcome==='allowed'&&String(x.marker?.nodeOptions).includes('egress-offline-guard.mjs'),
    'new ChildProcess().spawn with a forbidden path argument':x=>x.outcome==='denied'&&x.marker===null,
    'module.register (loader thread)':x=>x.outcome==='denied'&&x.marker===null,
    // test hooks keep using registerHooks in the same thread, behind the guard's own hooks
    'module.registerHooks (no-op hooks)':x=>x.outcome==='allowed',
  };
  const checks=Object.fromEntries(Object.entries(expect).map(([k,f])=>[k,f(row(k))]));
  const reports=fs.existsSync(join(dir,'guard-reports'))?fs.readdirSync(join(dir,'guard-reports')).map(n=>fs.readFileSync(join(dir,'guard-reports',n),'utf8')):[];
  const keyLeak=[text,JSON.stringify(r),...reports].some(t=>t.includes(key)||t.includes(encodeURIComponent(key))||t.includes(Buffer.from(key).toString('base64')));
  const handRow=reports.map(t=>JSON.parse(t)).flatMap((p:any)=>p.children??[]).find((c:any)=>c.method==='ChildProcess.spawn');
  result.modes[mode]={code,grandchildren:r.grandchildren,rows:r.rows,checks,keyLeak,reportRowForHandSpawn:handRow?{method:handRow.method,guardRequested:handRow.guardRequested,denied:handRow.denied}:null,
    stderrTail:text.split(key).join('[FAKEKEY]').slice(-400),pass:code===0&&!r.missing&&Object.values(checks).every(Boolean)&&!keyLeak&&(r.grandchildren??0)<=3};
  // put the folder back if the child stopped between the two renames
  if(fs.existsSync(join(dir,'parent-moved'))&&!fs.existsSync(join(dir,'parent')))fs.renameSync(join(dir,'parent-moved'),join(dir,'parent'));
}
result.pass=!result.STOPPED&&Object.keys(result.modes).length===2&&Object.values(result.modes).every((m:any)=>m.pass);
fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(join(scratch,'summary.json'),JSON.stringify(result,null,1));
console.log(JSON.stringify(result,null,1));
process.exit(result.pass?0:1);
