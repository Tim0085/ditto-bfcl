// Test-only: the fake API's CA reaches the egress here, so production code has no switch for it.
// Loaded into the scheduler after the offline guard. T9_FORGE adds the forgery attempts of tests/t9-live-run.ts.
import cp from 'node:child_process';
import fs from 'node:fs';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const spawnGuarded=cp.spawn;
cp.spawn=function(command,args,options,...rest){
  if(Array.isArray(args)&&String(args[1]).endsWith('egress-shell.ts')&&process.env.T9_CA_FILE)options={...options,env:{...options.env,NODE_EXTRA_CA_CERTS:process.env.T9_CA_FILE}};
  return spawnGuarded.call(this,command,args,options,...rest);
};
syncBuiltinESMExports();
const forge=process.env.T9_FORGE?JSON.parse(process.env.T9_FORGE):null;
if(forge){
  const {runRoot,keyFile,notKey,python,output}=forge,results=[],entry=join(process.cwd(),'src/ts/scheduler/egress-shell.ts'),egressArgs=key=>['--experimental-transform-types',entry,runRoot,key];
  const attempt=(label,command,args,options={})=>new Promise(done=>{
    const row={label};results.push(row);
    try{
      const child=cp.spawn(command,args,{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP,...options.env}});
      let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);
      child.once('error',error=>{row.error=String(error);done();});child.once('close',code=>{row.code=code;row.output=out.slice(-600);done();});
    }catch(error){row.thrown=String(error);done();}
  });
  const probe=`const cp=require('node:child_process');const key=process.argv[1],entry=process.argv[2],root=process.argv[3];process.argv[1]=process.env.T9_T8A;process.argv[2]='run';process.argv.push('--live');const r=cp.spawnSync(process.execPath,['--experimental-transform-types',entry,root,key],{cwd:process.cwd(),encoding:'utf8'});console.log(JSON.stringify({status:r.status,stderr:String(r.stderr).slice(-300),error:r.error?String(r.error):undefined}));`;
  const asyncProbe=`const cp=require('node:child_process');const key=process.argv[1],entry=process.argv[2],root=process.argv[3];process.argv[1]=process.env.T9_T8A;process.argv[2]='run';process.argv.push('--live');const c=cp.spawn(process.execPath,['--experimental-transform-types',entry,root,key],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let t='';c.stderr.on('data',b=>t+=b);c.on('close',s=>console.log(JSON.stringify({status:s,stderr:t.slice(-300)})));`;
  const timer=setInterval(async()=>{
    if(!fs.existsSync(forge.trigger))return;clearInterval(timer);
    await attempt('second egress from the scheduler, real key path',process.execPath,egressArgs(keyFile));
    await attempt('second egress from the scheduler, other path',process.execPath,egressArgs(notKey));
    await attempt('python child sees the offline guard',python,['-B','-c','import os;print(os.environ.get("NODE_OPTIONS",""))']);
    await attempt('node child sees the offline guard',process.execPath,['-e','console.log(process.env.NODE_OPTIONS,Object.getOwnPropertySymbols(globalThis).map(String).join())']);
    await attempt('node child forges the scheduler argv, spawn',process.execPath,['-e',asyncProbe,notKey,entry,runRoot],{env:{T9_T8A:join(process.cwd(),'scripts/t8a.ts')}});
    await attempt('node child forges the scheduler argv, spawnSync',process.execPath,['-e',probe,notKey,entry,runRoot],{env:{T9_T8A:join(process.cwd(),'scripts/t8a.ts')}});
    await attempt('node child reruns the scheduler itself',process.execPath,['--experimental-transform-types','scripts/t8a.ts','run','--root',runRoot,'--live','--key-file',notKey,'--live-authorization',forge.authorization]);
    let read='not denied';try{fs.readFileSync(keyFile);}catch(error){read=String(error.message);}
    let list='not denied';try{fs.readdirSync(join(keyFile,'..'));}catch(error){list=String(error.message);}
    fs.writeFileSync(output,JSON.stringify({results,schedulerReadsKeyFile:read,schedulerListsKeyDirectory:list},null,1));
  },50);timer.unref();
}
