// 所有禁止目标均为本脚本创建的无害Temp哨兵，绝不探测真实凭据文件。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync,spawn,fork,execFile,exec,execSync,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
const guard=pathToFileURL(resolve('scripts/egress-offline-guard.mjs')).href;
const self=pathToFileURL(resolve('scripts/offline-guard-selftest.mjs'));
const mode=process.argv[2];
if(!mode){
  const root=fs.mkdtempSync(join(os.tmpdir(),'t5-guard with space-'));
  const sealed=join(root,'sealed-sentinel');fs.mkdirSync(sealed);
  fs.writeFileSync(join(sealed,'sentinel.cjs'),'module.exports = "harmless sentinel";');
  fs.writeFileSync(join(root,'normal.txt'),'normal');
  fs.symlinkSync(sealed,join(root,'alias'),'junction');
  let symlink;
  try{fs.symlinkSync(join(sealed,'sentinel.cjs'),join(root,'symbol.cjs'),'file');symlink={created:true};}
  catch(e){symlink={created:false,code:e.code,reason:e.message};}
  fs.writeFileSync(join(root,'setup.json'),JSON.stringify({symlink}));
  const reports=fs.mkdtempSync(join(root,'reports-'));
  const result=spawnSync(process.execPath,['--import',guard,fileURLToPath(self),'probe',root],{
    encoding:'utf8',windowsHide:true,env:{...process.env,OFFLINE_GUARD_EXTRA_FORBIDDEN:JSON.stringify([sealed]),OFFLINE_GUARD_REPORT_DIR:reports}});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');assert.equal(result.status,0);
  const summary=spawnSync(process.execPath,['scripts/offline-guard-summary.mjs',reports],{encoding:'utf8',windowsHide:true});
  process.stdout.write(summary.stdout);process.stderr.write(summary.stderr);assert.equal(summary.status,0);
  console.log(JSON.stringify({positiveControls:true,root,reports,realCredentialsAccessed:false}));
}else if(mode==='child'){
  // 相对路径藏在程序内，不由父进程参数检查拦下；证明子进程确实自行加载guard。
  assert.throws(()=>fs.readFileSync(join(process.cwd(),'sealed-sentinel','sentinel.cjs')),/OFFLINE_GUARD/);
  console.log(JSON.stringify({inheritedGuard:true,pid:process.pid}));
  if(process.send)process.disconnect();
}else{
  const root=process.argv[3],sealed=join(root,'sealed-sentinel'),file=join(sealed,'sentinel.cjs'),normal=join(root,'normal.txt');
  const setup=JSON.parse(fs.readFileSync(join(root,'setup.json')));
  let count=0;
  async function denied(label,run){
    await assert.rejects(async()=>{const result=run();if(result?.then)await result;},/OFFLINE_GUARD/,label);
    count++;console.log(JSON.stringify({test:label,blocked:true}));
  }
  await denied('direct',()=>fs.readFileSync(file));
  const cwd=process.cwd();try{process.chdir(sealed);await denied('relative after chdir',()=>fs.readFileSync('sentinel.cjs'));}finally{process.chdir(cwd);}
  await denied('junction',()=>fs.readFileSync(join(root,'alias','sentinel.cjs')));
  if(setup.symlink.created)await denied('symbolic link',()=>fs.readFileSync(join(root,'symbol.cjs')));else console.log(JSON.stringify({test:'symbolic link',skipped:setup.symlink}));
  await denied('file URL',()=>fs.readFileSync(pathToFileURL(file)));
  await denied('Buffer',()=>fs.readFileSync(Buffer.from(file)));
  await denied('missing suffix',()=>fs.openSync(join(sealed,'missing','child'),'w'));
  await denied('case insensitive',()=>fs.readFileSync(file.toUpperCase()));
  for(const [label,target] of [['fs',fs],['fsp',fsp]])for(const base of ['readFile','open','openAsBlob','createReadStream','opendir','readdir','copyFile','cp','link','symlink','rename','stat','lstat','access','exists','statfs','readlink','realpath','watch','watchFile'])for(const suffix of target===fs?['','Sync']:['']){
    const name=base+suffix;if(typeof target[name]!=='function')continue;
    const double=['copyFile','cp','link','symlink','rename'].includes(base);
    await denied(`${label}.${name} source`,()=>target[name](file,...(double?[join(root,'out')]:[]),...(suffix===''&&target===fs&&!['createReadStream','openAsBlob','watch','watchFile'].includes(base)?[()=>{}]:[])));
    if(double)await denied(`${label}.${name} destination`,()=>target[name](normal,file,...(suffix===''&&target===fs?[()=>{}]:[])));
  }
  await denied('realpathSync.native',()=>fs.realpathSync.native(file));
  await denied('realpath.native',()=>fs.realpath.native(file,()=>{}));
  await denied('cp recursive traversal',()=>fsp.cp(root,join(os.tmpdir(),`t5-copy-${process.pid}`),{recursive:true}));
  for(const [name,fn]of [['readdirSync',()=>fs.readdirSync(root,{recursive:true})],['readdir promise',()=>fsp.readdir(root,{recursive:true})],['opendirSync',()=>fs.opendirSync(root,{recursive:true})],['opendir promise',()=>fsp.opendir(root,{recursive:true})]])await denied(name+' recursive traversal',fn);
  await denied('relative symlink target',()=>fs.symlinkSync('sealed-sentinel/sentinel.cjs',join(root,'another.cjs')));
  await denied('import',()=>import(pathToFileURL(file).href));
  await denied('require',()=>createRequire(import.meta.url)(file));
  await denied('non-Node argument',()=>spawnSync(process.env.ComSpec??'cmd.exe',['/d','/c','type',file]));
  await denied('non-Node junction argument',()=>spawn('cmd.exe',['/d','/c','type',join(root,'alias','sentinel.cjs')]));
  await denied('shell embedded path',()=>exec(`type "${file}"`,()=>{}));
  for(const [label,fn]of [['execSync',()=>execSync(`type "${file}"`)],['execFile',()=>execFile('cmd.exe',['/c','type',file],()=>{})],['execFileSync',()=>execFileSync('cmd.exe',['/c','type',file])]])await denied(label,fn);
  for(const [label,fn]of [['net.connect',()=>net.connect(80,'example.invalid')],['net.createConnection',()=>net.createConnection({port:80,host:'example.invalid'})],['socket.connect',()=>new net.Socket().connect(80,'example.invalid')],['tls.connect',()=>tls.connect(443,'example.invalid')],['dns.lookup',()=>dns.lookup('example.invalid',()=>{})],['dns.promises.lookup',()=>dns.promises.lookup('example.invalid')],['dns.resolve4',()=>dns.resolve4('example.invalid',()=>{})],['dns.promises.resolve',()=>dns.promises.resolve('example.invalid')],['fetch',()=>fetch('http://example.invalid')],['http override',()=>http.request('http://localhost',{hostname:'example.invalid'})]])await denied(label,fn);
  assert.equal(fs.readFileSync(normal,'utf8'),'normal');assert.equal(await fsp.readFile(normal,'utf8'),'normal');
  assert(fs.readFileSync('node_modules/@codesoul-co/ditto/package.json').equals(fs.readFileSync('vendor/ditto/package.json')));
  const index=JSON.parse(fs.readFileSync('runs/offline/replay-index/index.json'));
  const entry=Object.values(index.records)[0];assert(JSON.parse(fs.readFileSync(join('../../bfcl_direct/runs/multiturn-full800-001/model-records',entry.file))).rawResponse);
  console.log(JSON.stringify({normalReads:true,nodeModulesJunction:true,oldModelRecords:true}));
  for(const method of ['spawn','fork','execFileSync']){
    const options={cwd:root,env:{},windowsHide:true,stdio:['ignore','pipe','pipe',...(method==='fork'?['ipc']:[])]};
    if(method==='execFileSync'){
      const result=execFileSync(process.execPath,[resolve('scripts/offline-guard-selftest.mjs'),'child'],{...options,encoding:'utf8'});console.log(result);continue;
    }
    const child=method==='fork'?fork(resolve('scripts/offline-guard-selftest.mjs'),['child'],{...options,execArgv:[]}):spawn(process.execPath,[resolve('scripts/offline-guard-selftest.mjs'),'child'],options);
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});assert.equal(code,0,stderr);console.log(stdout.trim());
  }
  // 只向cmd查询普通Temp目录的8.3名称；不把禁区路径交给子进程。
  const short=spawnSync('cmd.exe',['/d','/c','for %I in (.) do @echo %~fsI'],{cwd:root,encoding:'utf8',windowsHide:true});
  const shortRoot=short.stdout?.trim().replace(/^"|"$/g,'');
  if(short.status===0&&shortRoot&&shortRoot.toLowerCase()!==root.toLowerCase())await denied('8.3 short parent',()=>fs.readFileSync(join(shortRoot,'sealed-sentinel','sentinel.cjs')));
  else console.log(JSON.stringify({test:'8.3 short path',skipped:true,reason:'Temp directory has no distinct 8.3 alias',status:short.status}));
  console.log(JSON.stringify({blockedChecks:count,allPassed:true}));
}
