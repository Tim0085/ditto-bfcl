import { opendir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { positionKey } from '../src/ts/egress/backends/replay.ts';
const categories=['multi_turn_base','multi_turn_miss_func','multi_turn_miss_param','multi_turn_long_context'];
export async function buildReplayIndex(source:string,output:string){
  const tasks=new Map<string,string>(),expected=new Map<string,{id:string;terminal:boolean}>();
  for(const category of categories)for(let n=0;n<200;n++){
    const caseId=`${category}_${n}`,task=JSON.parse(await readFile(join(source,'full',category,'monolithic','monolithic-c1','tasks',`${caseId}.json`),'utf8'));
    if(task.caseId!==caseId||task.transcriptFormat!=='full'||tasks.has(task.taskId))throw new Error(`旧单题身份或完整轨迹无效：${caseId}`);
    tasks.set(task.taskId,caseId);
    for(const step of task.modelSteps){
      const key=positionKey(caseId,step.turn,step.step);
      if(expected.has(key))throw new Error(`重复旧位置：${key}`);
      expected.set(key,{id:step.output.message.metadata.budgetReceipt.id,terminal:step.output.finishReason==='error'});
    }
  }
  const records:Record<string,{file:string;sha256:string}>={},attempts=new Map<string,number[]>();
  let scanned=0,selected=0,terminalRecords=0;
  // opendir逐个枚举，每次只读取一份JSON；内存仅留下位置、文件名、哈希、尝试编号。
  for await(const entry of await opendir(join(source,'model-records'))){
    if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
    const bytes=await readFile(join(source,'model-records',entry.name));
    const row=JSON.parse(bytes.toString('utf8'));scanned++;
    const caseId=tasks.get(row.taskId);if(!caseId)continue;
    const key=positionKey(caseId,row.logicalTurn,row.logicalStep),want=expected.get(key);
    const tries=attempts.get(key)??[];tries.push(row.retryAttempt);attempts.set(key,tries);
    if(!want||row.reservationId!==want.id)continue;
    if(row.caseId!==caseId||!row.rawResponse||!(row.status==='completed'||(want.terminal&&row.ledgerSettled&&row.errorCategory==='response')))throw new Error(`选中记录不是已完成响应：${key}`);
    if(records[key])throw new Error(`重复成功记录：${key}`);
    records[key]={file:entry.name,sha256:createHash('sha256').update(bytes).digest('hex')};selected++;
    if(want.terminal)terminalRecords++;
  }
  for(const key of expected.keys())if(!records[key])throw new Error(`缺少回放记录：${key}`);
  const retries=[...attempts].filter(([,tries])=>tries.length>1||tries.some(n=>n>0)).sort(([a],[b])=>a<b?-1:1).map(([position,tries])=>({position,attempts:tries.sort((a,b)=>a-b)}));
  const index={version:1,tasks:[...tasks.values()].sort(),records:Object.fromEntries(Object.entries(records).sort(([a],[b])=>a<b?-1:1))};
  const summary={scanned,tasks:tasks.size,positions:selected,terminalRecords,retryPositions:retries.length,retryCases:[...new Set(retries.map(x=>x.position.split('/')[0]))].sort(),retries};
  await mkdir(output,{recursive:true});
  for(const [name,value]of Object.entries({'index.json':index,'summary.json':summary}))await writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(summary));return index;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{source:{type:'string',default:'../../bfcl_direct/runs/multiturn-full800-001'},output:{type:'string',default:'runs/offline/replay-index'}}});
  await buildReplayIndex(resolve(values.source!),resolve(values.output!));
}
