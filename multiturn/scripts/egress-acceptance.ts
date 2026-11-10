// T5的最小驱动：不使用T3/T4，不执行Python工具，观察只取自固定夹具或旧完整轨迹。
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { startEgress } from '../src/ts/egress/server.ts';
import { loadEgressConfig } from '../src/ts/egress/config.ts';
import { loadActions, loadTasks, questionForTurn, categoryDataFile, MULTI_TURN_CATEGORIES } from '../src/ts/egress/model_config.ts';
import { modelSystem, buildRequest } from '../src/ts/egress/model.ts';
import { assistantMessage, toolMessage } from '../src/ts/egress/offline.ts';
import { MODEL_ENDPOINT_PROTOCOL } from '../src/ts/model-endpoint.ts';
import type { Message } from '../src/ts/egress/types.ts';
const mode=process.argv[2];if(!['fixtures','replay'].includes(mode))throw new Error('use fixtures or replay');
await mkdir('runs/offline/t5-acceptance',{recursive:true});
const out=await mkdtemp(`runs/offline/t5-acceptance/${mode}-`),c=await loadEgressConfig('config/egress.offline.json',mode as 'fixtures'|'replay');
let time=1800000000000;
const service=await startEgress(c,out,{clock:{now:()=>time,monotonicNow:()=>time,sleep:async(ms)=>{time+=ms;}}});
function post(body:any):Promise<any>{return new Promise((yes,no)=>{const q=request(service.url,{method:'POST',headers:{'content-type':'application/json'}},r=>{let text='';r.on('data',x=>text+=x);r.on('end',()=>{try{yes(JSON.parse(text));}catch(e){no(e);}});r.on('error',no);});q.on('error',no);q.end(JSON.stringify(body));});}
let total=0,cases=0;
async function ask(caseId:string,turn:number,step:number,messages:Message[]){
  const identity={configId:`${mode}-driver`,taskId:`${out}/${caseId}`,caseId,turn,step};
  const input={messages,actions:await loadActions(caseId,turn),model:{provider:'configured',model:c.settings.model.model},generation:{maxTokens:c.settings.model.maxOutputTokens},metadata:identity};
  const response=await post({protocol:MODEL_ENDPOINT_PROTOCOL,...identity,input});assert.equal(response.ok,true,JSON.stringify(response));
  const metadata=response.output.message.metadata,receipt=metadata.budgetReceipt;
  assert(service.gateway.ledger.settlements.has(receipt.id));
  assert.equal(service.gateway.ledger.reservations.get(receipt.id).configId,identity.configId);
  for(const [key,n]of Object.entries(metadata.modelTiming))if(key.endsWith('Ms'))assert(typeof n==='number'&&n>=0);
  total++;return {output:response.output,input};
}
const modelPart=(output:any)=>{const x=structuredClone(output);delete x.usage;for(const key of ['budgetReceipt','modelTiming','failedModelAttempts'])delete x.message.metadata[key];return x;};
try{
  if(mode==='fixtures'){
    for(const category of MULTI_TURN_CATEGORIES){
      const fixture=JSON.parse(await readFile(categoryDataFile(category,'fixtures'),'utf8'));
      const tasks=await loadTasks([category]);let categorySteps=0;
      for(const task of tasks){
        const ref=fixture.cases.find((x:any)=>x.id===task.id);const messages:Message[]=[structuredClone(modelSystem)];
        for(let turn=1;turn<=task.question.length;turn++){
          messages.push(...questionForTurn(task,turn));let step=1;
          for(const expected of ref.turns[turn-1]){
            const {output}=await ask(task.id,turn,step++,messages);categorySteps++;
            assert.equal(output.finishReason,'action_request');assert.equal(output.actionRequests.length,1);
            const action=output.actionRequests[0];assert.equal(action.name,expected.name);assert.deepEqual(action.arguments,expected.arguments);
            messages.push(assistantMessage(output),toolMessage(action.id,action.name,expected.observation));
          }
          const {output}=await ask(task.id,turn,step,messages);categorySteps++;assert.equal(output.finishReason,'stop');messages.push(assistantMessage(output));
        }
        cases++;
      }
      console.log(JSON.stringify({category,cases:200,steps:categorySteps,requestMismatches:0}));
    }
  }else{
    const source=c.replay!.source,index=JSON.parse(await readFile(c.replay!.index,'utf8'));
    const selected=MULTI_TURN_CATEGORIES.flatMap(category=>Array.from({length:10},(_,i)=>`${category}_${i}`));
    selected.push('multi_turn_miss_param_125'); // 索引实际唯一重试题，另加，不替代每类10题。
    await writeFile(join(out,'selection.json'),JSON.stringify(selected,null,2)+'\n',{flag:'wx'});
    for(const caseId of selected){
      const category=caseId.replace(/_\d+$/,''),task=JSON.parse(await readFile(join(source,'full',category,'monolithic/monolithic-c1/tasks',caseId+'.json'),'utf8'));
      assert.equal(task.transcriptFormat,'full');let cursor=0;
      for(const step of task.modelSteps){
        while(cursor<task.messages.length&&task.messages[cursor].role!=='assistant')cursor++;
        const messages=task.messages.slice(0,cursor);
        const {output,input}=await ask(caseId,step.turn,step.step,messages);
        assert.deepEqual(modelPart(output),modelPart(step.output));assert.deepEqual(output.usage,step.output.usage);
        assert.notEqual(output.message.metadata.budgetReceipt.id,step.output.message.metadata.budgetReceipt.id);
        const entry=index.records[`${caseId}/${step.turn}/${step.step}`],record=JSON.parse(await readFile(join(source,'model-records',entry.file),'utf8'));
        assert.deepEqual(buildRequest(input,c.settings),record.requestBody);
        cursor++;
      }
      cases++;
    }
    // requests.jsonl逐行读取，避免同时持有所有长请求体。
    const {createReadStream}=await import('node:fs'),{createInterface}=await import('node:readline');let count=0;
    for await(const line of createInterface({input:createReadStream(join(out,'requests.jsonl')),crlfDelay:Infinity})){
      const row=JSON.parse(line);assert.equal(row.differences.length,0);assert.equal(row.configId,'replay-driver');count++;
    }
    assert.equal(count,total);
  }
  const summary={mode,cases,steps:total,requestMismatches:0,outputMismatches:0,ledger:service.gateway.ledger.snapshot(),output:out};
  await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(summary));
}finally{await service.close();}
