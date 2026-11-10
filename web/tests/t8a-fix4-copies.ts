import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {json,read,env,ROOT} from '../src/ts/scheduler/io.ts';
if(process.argv[2]==='child'){
 const source=resolve(process.argv[3]),root=resolve(process.argv[4]);
 const {runSchedule}=await import(pathToFileURL(join(source,'src/ts/scheduler/scheduler.ts')).href);
 const {freeze}=await import(pathToFileURL(join(source,'src/ts/scheduler/plan.ts')).href);
 const {stage}=await import(pathToFileURL(join(source,'tests/t8a-helpers.ts')).href);
 freeze(stage('fix4-copies-'+process.pid),root);
 const release=new Promise<void>(r=>process.once('message',()=>r()));
 try{await runSchedule(root,{kind:'local-process',toUnitView:(s:any)=>s.block,list:async()=>{process.send!({ready:true,source});await release;throw Error('own test release');},adopt:async()=>undefined,start:async()=>{throw Error('must not launch');}});}catch(e){if(String(e).includes('own test release')){console.log('owned scheduler released');process.exitCode=0;}else{console.error(String(e));process.exitCode=2;}}finally{process.disconnect?.();}
}else{
 const root=resolve(process.argv[2]),other=resolve(process.argv[3]);
 function start(source:string,label:string){const run=join(root,label);const args=['--experimental-transform-types',fileURLToPath(import.meta.url),'child',source,run];const p=spawn(process.execPath,args,{cwd:source,env:{...env(join(run,'guards')),NODE_OPTIONS:'--import='+pathToFileURL(join(source,'scripts/egress-offline-guard.mjs')).href},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';p.stdout!.on('data',b=>stdout+=b);p.stderr!.on('data',b=>stderr+=b);const done=new Promise<number|null>(r=>p.once('close',code=>{json(join(run,'process.json'),{command:[process.execPath,...args],pid:p.pid,code,stdout,stderr});r(code);}));const ready=new Promise<void>((r,j)=>{p.once('message',()=>r());p.once('exit',()=>j(Error(stderr)));});return {p,done,ready,run};}
 const a=start(ROOT,'first');let b:ReturnType<typeof start>|undefined;
 try{await a.ready;b=start(other,'second');b.ready.catch(()=>{});assert.equal(await b.done,2);assert.match(read(join(b.run,'process.json')).stderr,/Another scheduler is active/);console.log(JSON.stringify({first:ROOT,second:other,blocked:true}));}finally{if(a.p.connected)a.p.send('finish');await a.done;if(b&&b.p.exitCode===null){b.p.kill();await b.done;}}
}
