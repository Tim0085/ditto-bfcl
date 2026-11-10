import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {read,json} from '../src/ts/scheduler/io.ts';
const root=resolve(process.argv[2]),split=resolve(process.argv[3]),original=cp.spawn,argv=process.argv;let replaced=0;
cp.spawn=((file:any,args:any,settings:any)=>{
 if(file===process.execPath&&args.includes('tests/t8c-matrix.ts')){
  const actual=['--import','./scripts/egress-offline-guard.mjs','-e','setTimeout(()=>console.log("Measurement lifecycle only; no matrix, model tasks or performance experiment executed"),4000)'];
  json(join(root,'lifecycle-substitution.json'),{declared:['node',...args],actual:['node',...actual],purpose:'A short owned idle child replaces only the matrix workload; host/VM monitoring and Docker cleanup run verbatim'});replaced++;return original(file,actual,settings);
 }
 return original(file,args,settings);
}) as any;syncBuiltinESMExports();
try{
 process.argv=[process.execPath,'tests/t8c-fix1-capacity.ts',root,split];const url=pathToFileURL(resolve('tests/t8c-fix1-capacity.ts'));url.search='observer-lifecycle';await import(url.href);assert.equal(replaced,1);
 const vm=read(join(root,'vm-capacity.json'));assert.equal(vm.observerExitCode,143);assert.equal(vm.observerOomKilled,false);assert(vm.samples>1);json(join(root,'verification.json'),{status:'PASS',measurementLifecycleOnly:true,matrixExecuted:false,modelTasks:0,initEnabled:true,observerExitCode:vm.observerExitCode,observerOomKilled:false,vmSamples:vm.samples},true);console.log(JSON.stringify({status:'PASS',measurementLifecycleOnly:true,modelTasks:0,observerExitCode:vm.observerExitCode,vmSamples:vm.samples}));
}finally{cp.spawn=original;syncBuiltinESMExports();process.argv=argv;}
