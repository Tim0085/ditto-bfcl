// T11 第 1 条容器演示：真实命令行、真实容器、本机 HTTPS 假 API（同 t9-live-run.ts）。
// 假 API 按请求内容给 0.5–3 秒固定延迟（种子 20261108，同一请求改前改后延迟相同），回复仍是旧记录原样。
// Uniform 8 份、Targeted 8 份 × 并发 4、8，一块 8 道 base 题；统计问模型（SAMPLE）在 Worker 里的排队。
// Usage: node --experimental-transform-types tests/t11-queue-demo.ts <label> --tag=<image tag>
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {rmSync,mkdirSync,readFileSync} from 'node:fs';
import {FakeApi,certificates,fakeKeys,liveStage,t8a,liveArgs,freezeLive,scratchRoot,read,json,files,lines,sleep,ROOT} from './t9-live-helpers.ts';
const label=process.argv[2],tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev';
if(!/^[a-z0-9-]+$/.test(label??''))throw Error('label required');
const runRoot=join(scratchRoot,'l',label),aux=join(scratchRoot,'x',label);for(const old of [runRoot,aux])rmSync(old,{recursive:true,force:true});mkdirSync(aux,{recursive:true});
const tls=certificates(join(scratchRoot,'ca'),'C:/Program Files/Git/ucrt64/bin/openssl.exe');
let keys:ReturnType<typeof fakeKeys>;const api=await new FakeApi(()=>keys.apiKey).start(tls);keys=fakeKeys(label,api.url);
const cases=read(join(ROOT,'config/t9-selection.json')).caseIds.filter((c:string)=>c.startsWith('multi_turn_base_')).slice(0,8);
const ids=['uniform-8-c4','uniform-8-c8','targeted-8-c4','targeted-8-c8'];
const delayMs=(body:Buffer)=>500+createHash('sha256').update('20261108').update(body).digest().readUInt32BE(0)%2501;
const delays:number[]=[];
api.load(cases);api.behavior=async call=>{const d=delayMs(call.body);delays.push(d);await sleep(d);};
const ns=(s:any)=>Number(BigInt(s.ns))/1e6;
const pct=(xs:number[],p:number)=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)];};
try{
  const plan=await freezeLive(liveStage('t11-'+label,tag,ids,cases),runRoot,aux);
  const r=await t8a(liveArgs(runRoot,keys.file,plan.hash,'t11 fake api queue demo'),aux,'run-1',{ca:tls.ca}).done;
  assert.equal(r.code,0,r.stderr);const report=read(join(runRoot,'scheduler','stop-report.json'));assert.equal(report.status,'complete',JSON.stringify(report));
  assert.equal(api.mismatches,0,'request bodies identical to the old records');
  const all=files(runRoot),errors=all.filter(p=>!p.endsWith('.gz')).filter(p=>/NoWorkerAvailableError|Worker capacity exceeded|No available Worker/.test(readFileSync(p,'utf8')));
  const out:any={label,tag,planHash:plan.hash,cases,received:api.received,mismatches:api.mismatches,delayMs:{min:Math.min(...delays),max:Math.max(...delays),n:delays.length},
    filesWithNoWorkerErrors:errors.map(p=>p.slice(runRoot.length)),configs:{}};
  for(const id of ids){
    const stepFiles=all.filter(p=>p.replaceAll('\\','/').includes(`/configs/${id}/workers/`)&&p.endsWith('.steps.jsonl'));
    const rows=stepFiles.flatMap(p=>lines(p)).filter((x:any)=>x.received&&x.started&&x.ended).map((x:any)=>({worker:x.workerId,node:x.node,received:ns(x.received),started:ns(x.started),ended:ns(x.ended)}));
    const byNode=(node:string,role:string)=>{
      const mine=rows.filter(x=>x.node===node),copies=[...new Set(rows.filter(x=>x.worker.startsWith(role+'-')).map(x=>x.worker))].sort();
      const queue=mine.map(x=>x.started-x.received);
      // "有空闲份却排队"：这一步排队超过 100 毫秒，而它到达时同类另有一份手上一件都没有（没在做、也没排队）。
      const idleElsewhere=mine.filter(x=>x.started-x.received>100&&copies.some(c=>c!==x.worker&&!rows.some(y=>y.worker===c&&y.received<=x.received&&x.received<y.ended)));
      return {copies:copies.length,steps:mine.length,queueMs:{median:pct(queue,0.5),p95:pct(queue,0.95),max:pct(queue,1)},queuedOver100ms:queue.filter(q=>q>100).length,
        queuedWhileAnotherCopyIdle:idleElsewhere.length,worstIdleElsewhereMs:idleElsewhere.length?Math.max(...idleElsewhere.map(x=>x.started-x.received)):0};
    };
    out.configs[id]={stepFiles:stepFiles.length,sample:byNode('INFER.REASONING.SAMPLE','Infer'),observe:byNode('INTERACTION.OBSERVE','Interaction')};
  }
  json(join(aux,'queue.json'),out);console.log(JSON.stringify(out));
}finally{await api.stop();}
process.exit(0);
