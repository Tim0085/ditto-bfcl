import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer,request} from 'node:http';
import {createServer as tcp} from 'node:net';
import {once} from 'node:events';
import {DockerLauncher} from '../src/ts/docker/launcher.ts';
import {docker,save} from '../src/ts/docker/common.ts';
import {block,launchBlock,egress,sleep} from './t7-helpers.ts';
const root=resolve(process.env.SEC1_FIX4_EVIDENCE??'runs/offline/t8b-fix4-20261106','egress-'+process.pid);await mkdir(root,{recursive:true});
const tag=process.env.SEC1_FIX4_TAG??'test-t8b-fix4',imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id;
const runId='t8b-fix4-egress-'+process.pid,rows:any[]=[],runtime={clockTicks:100,pageBytes:4096};
async function closedPort(){const s=tcp();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
async function jsonl(path:string){return (await readFile(path,'utf8').catch(()=>'')).split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));}
async function budgets(dir:string):Promise<any[]>{let out:any[]=[];for(const e of await readdir(dir,{withFileTypes:true}).catch(()=>[])){if(e.isDirectory())out.push(...await budgets(join(dir,e.name)));else if(e.name.endsWith('.jsonl'))out.push(...(await jsonl(join(dir,e.name))).filter(r=>r.kind==='reserve'));}return out;}
async function endpoint(dir:string,mode:string){
  const backend=await egress(dir,'replay');let bytes=0,requests=0,timer:ReturnType<typeof setTimeout>|undefined,downAt=0,upAt=0;
  const observations:any[]=[];
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req){chunks.push(Buffer.from(chunk));bytes+=chunk.length;}requests++;
    if(mode==='reset'){res.destroy();return;}
    const response=await new Promise<Buffer>((yes,no)=>{
      const r=request(backend.url,{method:'POST',headers:{'content-type':'application/json'},agent:false},reply=>{
        res.statusCode=reply.statusCode??500;const data:Buffer[]=[];reply.on('data',b=>data.push(Buffer.from(b)));reply.once('end',()=>yes(Buffer.concat(data)));reply.once('error',no);
      });r.once('error',no);r.end(Buffer.concat(chunks));
    });
    if(mode==='blip'&&requests===1){
      // Close the listener BEFORE releasing the first response: next request sees refusal.
      server.close();downAt=Date.now();observations.push({phase:'down',bytes,requests,reserves:(await budgets(join(dir,'egress'))).length});
      timer=setTimeout(()=>{server.listen(port,'127.0.0.1');upAt=Date.now();},4000);
    }
    res.end(response);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;
  const poll=setInterval(()=>{if(downAt&&!upAt)observations.push({phase:'unreachable',at:Date.now(),bytes,requests});},25);
  return {url:`http://127.0.0.1:${port}`,get stats(){return {bytes,requests,downAt,upAt,downMs:upAt-downAt,observations};},
    async close(){clearInterval(poll);if(timer)clearTimeout(timer);server.closeAllConnections();await new Promise<void>(r=>server.listening?server.close(()=>r()):r());await backend.close();}};
}
async function run(name:string,path:'container'|'local',group:'Direct'|'Monolithic'|'Uniform',url:string){
  const dir=join(root,name);await mkdir(dir,{recursive:true});const b=await block(dir,url,group,'test',1,['multi_turn_base_0']);b.runId=runId;
  const started=Date.now();let exit:any;
  if(path==='container')exit=await (await new DockerLauncher(imageId,runtime,tag).start({runId,unitId:name,block:{...b},outputRoot:dir,logDir:join(dir,'unit'),guardReportDir:join(dir,'guards'),egressUrl:url})).wait();
  else {const p=await launchBlock(b),result=await p.done;exit={exitCode:result.code,summary:JSON.parse(await readFile(join(p.directory,'block-summary.json'),'utf8'))};}
  const steps=(await jsonl(join(dir,'configs','test','steps.jsonl'))).filter(r=>r.node==='INFER.REASONING.SAMPLE');
  return {path,group,name,ms:Date.now()-started,exit,steps,relay:await jsonl(join(dir,'unit','relay.jsonl'))};
}
for(const group of ['Direct','Monolithic','Uniform'] as const)for(let i=0;i<({Direct:3,Monolithic:2,Uniform:1}[group]);i++){
  const pair=[];
  for(const path of ['container','local'] as const){
    const name=`blip-${group}-${i}-${path}`,dir=join(root,name+'-gateway');await mkdir(dir);const gateway=await endpoint(dir,'blip');
    try{
      const result=await run(name,path,group,gateway.url),ledger=await budgets(join(dir,'egress'));
      assert.equal(result.exit.exitCode,0,JSON.stringify(result.exit));assert.equal(result.exit.summary.completed,1);
      const retried=result.steps.filter(r=>r.connectRetries>0);assert.equal(retried.length,1);assert.equal(retried[0].connectRetries,3);
      assert(retried[0].connectRetryWaitMs>=6970&&retried[0].connectRetryWaitMs<10000);
      assert.equal(ledger.length,gateway.stats.requests,'each real accepted request has one reservation');
      const down=gateway.stats.observations.find(r=>r.phase==='down');assert.equal(down.reserves,1);
      for(const o of gateway.stats.observations.filter(r=>r.phase==='unreachable')){assert.equal(o.bytes,down.bytes);assert.equal(o.requests,1);}
      if(path==='container')assert.equal(result.relay.length,3);
      const row={scenario:'blip',...result,ledgerReservations:ledger.length,gateway:gateway.stats};rows.push(row);pair.push(row);console.log(JSON.stringify({...row,steps:result.steps.map(s=>({connectRetries:s.connectRetries,connectRetryWaitMs:s.connectRetryWaitMs})),gateway:{...gateway.stats,observations:gateway.stats.observations.length}}));
    }finally{await gateway.close();}
  }
  assert.deepEqual(pair.map(p=>p.steps.map(s=>s.connectRetries)),[pair[0].steps.map(s=>s.connectRetries),pair[0].steps.map(s=>s.connectRetries)]);
}
for(const mode of ['dead','reset'])for(const path of ['container','local'] as const){
  const name=mode+'-'+path,dir=join(root,name+'-gateway');await mkdir(dir);const gateway=mode==='reset'?await endpoint(dir,mode):undefined;
  try{
    const result=await run(name,path,'Direct',gateway?.url??`http://127.0.0.1:${await closedPort()}`),first=result.steps[0];
    assert.equal(result.exit.exitCode,1);assert.equal(result.exit.summary.stopCategory,'出口停止');
    assert.equal(first.connectRetries,mode==='dead'?3:0);assert.match(first.error,new RegExp('BFCL_RUN_STOP:.*"attempts":'+(mode==='dead'?4:1)));
    if(path==='container')assert.equal(result.relay.length,mode==='dead'?4:0);
    if(mode==='dead')assert(first.connectRetryWaitMs>=6970&&first.connectRetryWaitMs<10000);
    else assert.equal(gateway!.stats.requests,1);
    rows.push({scenario:mode,...result});console.log(JSON.stringify({scenario:mode,...result,steps:result.steps.map(s=>({connectRetries:s.connectRetries,connectRetryWaitMs:s.connectRetryWaitMs,error:s.error}))}));
  }finally{await gateway?.close();}
}
await save(join(root,'assertions.json'),{imageId,rows});assert.deepEqual(await new DockerLauncher(imageId,runtime,tag).list(runId),[]);
console.log('PASS: real replay egress, no bytes/reservations for failed connections, Direct3/Monolithic2/Uniform1 paired; dead4/reset1');
