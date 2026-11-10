// 离线容量验收：真实独立出口进程 + 本机假HTTP；真实墙钟，完整保留所有轮次。
import {createServer,request, type ServerResponse} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
import {mockResponse} from '../src/ts/egress/mock.ts';
import {MODEL_ENDPOINT_PROTOCOL} from '../src/ts/model-endpoint.ts';
const {values}=parseArgs({options:{output:{type:'string',default:'runs/offline/t5-fix-20261104/throughput'},rounds:{type:'string',default:'3'},'minimum-rpm':{type:'string',default:'3000'},only:{type:'string'}}});
const rounds=Number(values.rounds),minimum=Number(values['minimum-rpm']);
assert(Number.isSafeInteger(rounds)&&rounds>=3);assert(Number.isFinite(minimum)&&minimum>=3000);
await mkdir(values.output!,{recursive:true});const root=await mkdtemp(join(values.output!,'run-'));
const template=JSON.parse(await readFile('config/egress.offline.json','utf8'));
const capacity=JSON.parse(await readFile('config/egress.throughput.json','utf8'));
const conditions=[{name:'template',config:template,threshold:false},{name:'capacity',config:capacity,threshold:true},
  ...[10,5,2,1].map(minIntervalMs=>({name:`interval-${minIntervalMs}`,config:{...capacity,dispatchPolicy:{...capacity.dispatchPolicy,minIntervalMs}},threshold:false}))]
  .filter(c=>!values.only||c.name===values.only);
assert(conditions.length>0);
const results:any[]=[];
for(const condition of conditions){
  const samples=[];
  for(let round=1;round<=rounds;round++){
    const out=await mkdtemp(join(root,`${condition.name}-${round}-`));
    const configPath=join(out,'config.json');await writeFile(configPath,JSON.stringify(condition.config,null,2)+'\n',{flag:'wx'});
    const pending:ServerResponse[]=[];let active=0,peak=0;
    const raw=mockResponse({message:{role:'assistant',content:'done'},finishReason:'stop'},'deepseek-flash','chat-completions',0);
    const remote=createServer((req,res)=>{req.resume();active++;peak=Math.max(peak,active);pending.push(res);
      if(pending.length===81)for(const response of pending){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(raw));active--;}});
    await new Promise<void>(r=>remote.listen(0,'127.0.0.1',r));
    const child=spawn(process.execPath,['--import',pathToFileURL(resolve('scripts/egress-offline-guard.mjs')).href,'--experimental-transform-types','src/ts/egress/server.ts',
      '--backend','live','--host','127.0.0.1','--port','0','--config',configPath,'--output',join(out,'egress'),'--test-url',`http://127.0.0.1:${(remote.address() as any).port}`],
      {windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    let stdout='',stderr='';child.stderr!.on('data',x=>stderr+=x);
    const exited=new Promise<number|null>(r=>child.once('exit',r));
    try{
      const ready=await new Promise<any>((yes,no)=>{
        child.once('error',no);child.once('exit',code=>no(new Error(`exit ${code}: ${stderr}`)));
        child.stdout!.on('data',x=>{stdout+=x;for(const line of stdout.split('\n').slice(0,-1)){const value=JSON.parse(line);if(value.ready)yes(value);}});
      });
      assert.notEqual(ready.pid,process.pid);
      const start=performance.now();
      const responses=await Promise.all(Array.from({length:81},(_,i)=>new Promise<any>((yes,no)=>{
        const identity={configId:'capacity-probe',taskId:`parallel-${i}`,caseId:'multi_turn_base_0',turn:1,step:1};
        const body={protocol:MODEL_ENDPOINT_PROTOCOL,...identity,input:{metadata:identity,model:{model:'deepseek-flash'},messages:[{role:'user',content:'hello'}],actions:[]}};
        const q=request(ready.url,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(60000)},r=>{
          let text='';r.on('data',x=>text+=x);r.on('error',no);r.on('end',()=>{try{yes(JSON.parse(text));}catch(e){no(e);}});
        });q.on('error',no);q.end(JSON.stringify(body));
      })));
      const elapsedMs=performance.now()-start;assert(responses.every(r=>r.ok));assert.equal(peak,81);
      const sample={condition:condition.name,round,requests:81,peak,elapsedMs,requestsPerMinute:81*60000/elapsedMs,
        dispatchPolicy:condition.config.dispatchPolicy,config:configPath,pid:ready.pid};samples.push(sample);console.log(JSON.stringify(sample));
    }finally{
      // 只关闭本脚本新建的出口和假服务，不操作用户已有进程。
      for(const r of pending)if(!r.writableEnded)r.end(JSON.stringify(raw));
      if(child.connected)child.send('shutdown');assert.equal(await exited,0,stderr);
      await new Promise<void>(r=>remote.close(()=>r()));
      await writeFile(join(out,'child.log'),stdout+stderr,{flag:'wx'});
    }
  }
  const sorted=samples.map(s=>s.requestsPerMinute).sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
  const median=sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
  const result={condition:condition.name,rounds,medianRpm:median,minimumRpm:condition.threshold?minimum:null,pass:!condition.threshold||median>=minimum,samples};
  results.push(result);console.log(JSON.stringify({summary:result}));
}
await writeFile(join(root,'summary.json'),JSON.stringify(results,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:root,pass:results.every(r=>r.pass)}));
if(results.some(r=>!r.pass))process.exitCode=1;
