import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {DockerLauncher} from '../src/ts/docker/launcher.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {read,json,ROOT,sleep} from '../src/ts/scheduler/io.ts';
import type {RunUnitSpec} from '../src/ts/run-unit.ts';
const root=resolve(process.argv[2]),options=read(process.argv[3]),plan=read(join(root,'plan.json'));
const original=cp.spawn;
let inspectCalls=0,inspectHangInjected=false;
cp.spawn=((file:any,args:any,settings:any)=>{
  if(file==='docker'&&args[0]==='inspect'&&options.inspectHang&&!existsSync(join(root,'disabled'))&&++inspectCalls>=2&&!inspectHangInjected){
    inspectHangInjected=true;const child=original(process.execPath,['--import','./scripts/egress-offline-guard.mjs','-e','setInterval(()=>{},1000)'],settings);
    json(join(root,'docker-inspect-hung.json'),{pid:child.pid,at:new Date().toISOString(),command:[file,...args],fault:'This owned fake CLI never returns; the production docker() timeout must terminate only this CLI child'});return child;
  }
  if(file==='docker'&&args[0]==='start'&&options.neverStarted&&!existsSync(join(root,'disabled'))){
    json(join(root,'deliberately-not-started.json'),{at:new Date().toISOString(),command:[file,...args]});
    return original(process.execPath,['--import','./scripts/egress-offline-guard.mjs','tests/t8c-no-start.mjs'],settings);
  }
  if(file==='docker'&&args[0]==='create'&&args.includes('/app/scripts/docker-entry.py'))args=args.map((a:string)=>a==='/app/scripts/docker-entry.py'?'/unit/entry.py':a);
  return original(file,args,settings);
}) as typeof original;syncBuiltinESMExports();
let gate:ReturnType<typeof createServer>|undefined,restore:ReturnType<typeof setTimeout>|undefined,gateUrl:string|undefined,proxyCalls=0;
class FixtureDocker extends DockerLauncher{
  override async start(spec:RunUnitSpec){
    mkdirSync(spec.logDir,{recursive:true});
    let entry=readFileSync('scripts/docker-entry.py','utf8');
    entry=entry.replace("NODE_OPTIONS='--import=/app/scripts/egress-offline-guard.mjs'","NODE_OPTIONS='--import=/app/scripts/egress-offline-guard.mjs --import=/unit/hook.mjs'");
    writeFileSync(join(spec.logDir,'entry.py'),entry);writeFileSync(join(spec.logDir,'hook.mjs'),readFileSync('tests/t8c-unit-hook.mjs'));
    const fault=existsSync(join(root,'disabled'))||options.unitFault?.configId&&options.unitFault.configId!==spec.block.configId?{}:options.unitFault??{};
    json(join(spec.logDir,'fault.json'),fault);
    if(options.blip){
      if(!gate){const upstreamUrl=spec.egressUrl;gate=createServer(async(req,res)=>{
        const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));proxyCalls++;
        const data=await new Promise<Buffer>((yes,no)=>{const upstream=request(upstreamUrl,{method:'POST',headers:{'content-type':'application/json'},agent:false},reply=>{const chunks:Buffer[]=[];reply.on('data',b=>chunks.push(Buffer.from(b)));reply.once('end',()=>yes(Buffer.concat(chunks)));reply.once('error',no);});upstream.once('error',no);upstream.end(Buffer.concat(chunks));});
        if(proxyCalls===1){gate!.close();json(join(root,'blip-down.json'),{at:Date.now(),proxyCalls});restore=setTimeout(()=>{gate!.listen(port,'127.0.0.1');json(join(root,'blip-up.json'),{at:Date.now(),proxyCalls});},4000);}
        res.writeHead(200,{'content-type':'application/json'});res.end(data);
      });gate.listen(0,'127.0.0.1');await once(gate,'listening');var port=(gate.address() as any).port;gateUrl='http://127.0.0.1:'+port;}
      spec={...spec,egressUrl:gateUrl!};
    }
    const unit=await super.start(spec);
    const disabled=existsSync(join(root,'disabled'));
    if(!disabled){
      const barrier=options.requestBarrier??(fault.summaryHang?join(spec.logDir,'summary-blocked'):fault.hang?join(spec.logDir,'hang-entered.json'):undefined);
      if(barrier){const end=Date.now()+120000,cid=String(spec.block.configId);while(!existsSync(barrier)||(options.requestBarrier&&!(read(join(root,'egress/status.json')).active?.[cid]>0))){if(Date.now()>end)throw Error('Acceptance fault barrier not reached: '+barrier);await sleep(25);}
        json(join(spec.logDir,'acceptance-start-barrier.json'),{at:new Date().toISOString(),barrier,identifiedInFlight:read(join(root,'egress/status.json')).active?.[cid]??0,meaning:'The scheduler start reply is released only after the intended fault point; no production timer/counter is altered'});
      }
    }
    return options.lostStopReply?{...unit,stop:async(reason:string)=>{await unit.stop(reason);throw Error('t8c fixture: stop delivery acknowledged by Docker but caller reply lost');}}:unit;
  }
}
const l=plan.stage.launcher,launcher=l?.kind==='docker'?new FixtureDocker(l.imageId,l.runtime,l.tag,root):new LocalProcessLauncher(join(root,'scheduler','units'));
const imports:string[]=[];
if(options.egress){const url=pathToFileURL(join(ROOT,'tests/t8c-egress-hook.mjs'));url.searchParams.set('options',JSON.stringify(options.egress));imports.push(url.href);}
try{console.log(JSON.stringify(await runSchedule(root,launcher,{egressImports:imports,resumeAuthorization:options.authorization})));}
finally{if(restore)clearTimeout(restore);if(gate){gate.closeAllConnections();await new Promise<void>(r=>gate!.listening?gate!.close(()=>r()):r());}cp.spawn=original;syncBuiltinESMExports();}
