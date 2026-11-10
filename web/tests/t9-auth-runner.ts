// T9 scheduler process for real containers with per-attempt unit faults (options.faults keyed by a1, a2, ...).
// Same shape as tests/t8c-runner.ts; the production entry is copied to /unit/entry.py only to add the hook import.
import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {DockerLauncher} from '../src/ts/docker/launcher.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {read,json,ROOT} from '../src/ts/scheduler/io.ts';
import type {RunUnitSpec} from '../src/ts/run-unit.ts';
const root=resolve(process.argv[2]),options=read(process.argv[3]),plan=read(join(root,'plan.json'));
const original=cp.spawn;
cp.spawn=((file:any,args:any,settings:any)=>{if(file==='docker'&&args[0]==='create'&&args.includes('/app/scripts/docker-entry.py'))args=args.map((a:string)=>a==='/app/scripts/docker-entry.py'?'/unit/entry.py':a);return original(file,args,settings);}) as typeof original;syncBuiltinESMExports();
class Fixture extends DockerLauncher{
 override async start(spec:RunUnitSpec){
  mkdirSync(spec.logDir,{recursive:true});
  const entry=readFileSync(join(ROOT,'scripts/docker-entry.py'),'utf8').replace("NODE_OPTIONS='--import=/app/scripts/egress-offline-guard.mjs'","NODE_OPTIONS='--import=/app/scripts/egress-offline-guard.mjs --import=/unit/hook.mjs'");
  writeFileSync(join(spec.logDir,'entry.py'),entry);writeFileSync(join(spec.logDir,'hook.mjs'),readFileSync(join(ROOT,'tests/t9-auth-hook.mjs')));
  json(join(spec.logDir,'fault.json'),options.faults?.[spec.unitId.split('-').at(-1)!]??{});
  return super.start(spec);
 }
}
const l=plan.stage.launcher;
try{console.log(JSON.stringify(await runSchedule(root,new Fixture(l.imageId,l.runtime,l.tag,root),{resumeAuthorization:options.authorization})));}
finally{cp.spawn=original;syncBuiltinESMExports();}
