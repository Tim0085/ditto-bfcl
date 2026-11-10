import fs from 'node:fs/promises';
import syncfs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8')),mode=process.argv[3],actor=process.argv[4]??'child';
const write=fs.writeFile.bind(fs),read=fs.readFile.bind(fs),rename=fs.rename.bind(fs),spawn=cp.spawn.bind(cp);
const exists=p=>fs.access(p).then(()=>true,()=>false);
async function until(p){const end=Date.now()+90000;while(!await exists(p)){if(Date.now()>end)throw Error('Barrier timeout '+p);await new Promise(r=>setTimeout(r,20));}}
if(mode==='requested')fs.rename=async(...args)=>{await rename(...args);if(String(args[1]).includes('kill-requests')&&String(args[1]).endsWith('.json')&&JSON.parse(await read(args[1],'utf8')).status==='requested'){console.log('barrier: requested durable, dispatch not begun');process.exit(71);}};
if(mode==='dispatched')cp.spawn=(file,args,options)=>{
 if(file==='docker'&&args[0]==='kill'){
  const command=spawn(file,args,options);
  command.once('spawn',()=>{console.log('barrier: real docker kill process spawned, no receipt consumed');process.exit(72);});
  return command;
 }
 return spawn(file,args,options);
};
let first=true;
if(mode==='scheduled')fs.readFile=async(p,...args)=>{
 const value=await read(p,...args);
 if(String(p).endsWith('collector.lock')&&first){first=false;await write(join(input.root,actor+'-read-stale'),value);await until(join(input.root,'release-'+actor));}
 return value;
};
if(['scheduled','natural'].includes(mode))cp.spawn=(file,args,options)=>{
 if(file==='docker'&&['wait','logs','rm','stats','kill','stop'].includes(args[0]))syncfs.appendFileSync(join(input.root,actor+'-docker.jsonl'),JSON.stringify(args)+'\n');
 return spawn(file,args,options);
};
syncBuiltinESMExports();
const {DockerLauncher}=await import('../src/ts/docker/launcher.ts');
const launcher=new DockerLauncher(input.imageId,input.runtime);
const unit=await launcher.adopt(input.spec.runId,input.spec.unitId);
if(['requested','dispatched'].includes(mode)){await unit.kill('offline crash barrier, no model requests');throw Error('Crash barrier missed');}
await write(join(input.root,actor+'-ready'),'ready');await until(join(input.root,'go'));
try{const exit=await unit.wait();await write(join(input.root,actor+'-result.json'),JSON.stringify({ok:true,exit}));}
catch(e){await write(join(input.root,actor+'-result.json'),JSON.stringify({ok:false,error:String(e)}));}
