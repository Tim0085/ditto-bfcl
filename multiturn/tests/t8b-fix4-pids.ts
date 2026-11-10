import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,readFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {block,egress} from './t7-helpers.ts';
const original=cp.spawn;
const instrument="p='/app/scripts/docker-entry.py';s=open(p).read();s=s.replace('now = time.monotonic()', \"with open('/unit/pids-before.jsonl','a') as dense: dense.write(json.dumps({'at':time.time(),'current':values[0],'peak':values[1]})+'\\\\n')\\n        now = time.monotonic()\");exec(compile(s,p,'exec'))";
cp.spawn=((file:any,args:any,options:any)=>{
  if(file==='docker'&&args[0]==='create'&&args.includes('/app/scripts/docker-entry.py')){
    args=[...args];const i=args.indexOf('/app/scripts/docker-entry.py');args.splice(i,1,'-c',instrument);
  }
  return original(file,args,options);
}) as typeof original;syncBuiltinESMExports();
const {DockerLauncher}=await import('../src/ts/docker/launcher.ts');
const {docker,save,labels,removeExited}=await import('../src/ts/docker/common.ts');
const root=resolve(process.env.SEC1_FIX4_EVIDENCE??'runs/offline/t8b-fix4-20261106','pids-'+process.pid);await mkdir(root,{recursive:true});
const tag=process.env.SEC1_FIX4_TAG??'test-t8b-fix4',info=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0],imageId=info.Id;
assert(!Object.hasOwn(info.Config.Labels,'sec1.run'));assert(!Object.hasOwn(info.Config.Labels,'sec1.unit'));
await assert.rejects(access('scripts/docker-legacy-probe.ts'));
const runId='t8b-fix4-pids-'+process.pid,gateway=await egress(root,'replay');
try{
  const b=await block(root,gateway.url,'Direct','pids',1,['multi_turn_base_0','multi_turn_miss_func_0','multi_turn_miss_param_0','multi_turn_long_context_0']);b.runId=runId;b.sampling.strict=true;
  const spec={runId,unitId:'pids',block:{...b},outputRoot:root,logDir:join(root,'unit'),guardReportDir:join(root,'guards'),egressUrl:gateway.url};
  const exit=await (await new DockerLauncher(imageId,{clockTicks:100,pageBytes:4096},tag).start(spec)).wait();assert.equal(exit.exitCode,0);assert.equal((exit.summary as any).completed,4);
  const before=await readFile(join(spec.logDir,'pids-before.jsonl'),'utf8'),after=await readFile(join(spec.logDir,'pids.jsonl'),'utf8');
  const dense=before.trim().split(/\r?\n/).map(s=>JSON.parse(s)),sparse=after.trim().split(/\r?\n/).map(s=>JSON.parse(s));
  const a=Math.max(...dense.map(r=>r.peak)),z=Math.max(...sparse.map(r=>r.peak));assert.equal(a,z);assert(sparse.length<dense.length);assert(after.length<before.length);
  const row={completed:4,before:{lines:dense.length,bytes:Buffer.byteLength(before),peak:a},after:{lines:sparse.length,bytes:Buffer.byteLength(after),peak:z},sameCgroupSameSamplingCadence:true};await save(join(root,'assertions.json'),row);console.log(JSON.stringify(row));
}finally{await gateway.close();cp.spawn=original;syncBuiltinESMExports();}
const id=(await docker(['create','--pull=never',...labels(runId,'static'),'--network','none',imageId,'python3','-B','-c',"from pathlib import Path;assert not Path('/app/scripts/docker-legacy-probe.ts').exists();print('PASS: legacy probe absent from final image')"])).stdout.trim();
try{await docker(['start',id]);await docker(['wait',id]);const state=JSON.parse((await docker(['inspect',id])).stdout)[0],log=await docker(['logs',id]);await save(join(root,'image-static.json'),{state,log});assert.equal(state.State.ExitCode,0);console.log(log.stdout);}finally{await removeExited(id,runId,'static');}
