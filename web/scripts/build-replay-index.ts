import { createReadStream } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { positionKey } from '../src/ts/egress/backends/replay.ts';

const batch='web_search_no_snippet/r1-direct-c1';
const seed='web-a-20261109';
const redaction='[REDACTED]';
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
type Case = {caseId:string;taskId:string;toolCalls:number;status:string;terminationReason?:string;valid?:boolean;features:string[];redacted:boolean};
type Position = {started:number;line:number};
type ToolCall = {name:string;arguments:Record<string,unknown>;observation:string};
type ReplayRecord = {caseId:string;logicalTurn:number;logicalStep:number;requestBody:any;rawResponse:any};
type ModelRow = {taskId:string;startedEpochMs:number;requestId:string;request:any;response:any;settled:boolean};

async function scan(source:string, consume:(row:ModelRow,line:number,redacted:boolean)=>void|Promise<void>) {
  let line=0;
  const stream=createReadStream(join(source,'model-records.jsonl'),{encoding:'utf8'});
  const records=createInterface({input:stream,crlfDelay:Infinity});
  try {
    for await (const text of records) {
      line++;
      if(text.includes('-r1-direct-c1-'))await consume(JSON.parse(text),line,text.includes(redaction));
    }
  } finally {
    records.close();
    stream.destroy();
  }
  return line;
}

function features(task:any, valid:boolean|undefined):string[] {
  const result=new Set<string>();
  if(valid!==undefined)result.add(valid?'correct':'incorrect');
  if(task.terminationReason==='model_input_limit')result.add('input_limit');
  for(const call of task.snapshot.trace) {
    if(call.tool_name==='fetch_url_content') {
      result.add('fetch_'+(call.arguments.mode??'raw'));
      if(call.result?.error)result.add('fetch_error');
    }
    if(call.tool_name==='search_engine_query'&&Array.isArray(call.result)&&!call.result.length)result.add('empty_search');
  }
  return [...result].sort();
}

function choose(cases:Case[], count:number) {
  const eligible=cases.filter(c=>!c.redacted);
  if(eligible.length<count)throw new Error('未脱敏题不足 '+count);
  const tie=(a:Case,b:Case)=>sha(seed+'/'+a.caseId).localeCompare(sha(seed+'/'+b.caseId));
  const ordered=[...eligible].sort((a,b)=>a.toolCalls-b.toolCalls||tie(a,b));
  const picked=new Set<Case>([ordered[0],ordered.at(-1)!]);
  for(const feature of ['input_limit','empty_search','fetch_error','fetch_raw','fetch_markdown','fetch_truncate','correct','incorrect']) {
    if([...picked].some(c=>c.features.includes(feature)))continue;
    const candidate=eligible.filter(c=>c.features.includes(feature)).sort(tie)[0];
    if(candidate)picked.add(candidate);
  }
  const strata=Array.from({length:4},(_,i)=>ordered.slice(Math.floor(i*ordered.length/4),Math.floor((i+1)*ordered.length/4)).sort(tie));
  while(picked.size<count)for(const stratum of strata) {
    if(picked.size===count)break;
    const next=stratum.find(c=>!picked.has(c));
    if(next)picked.add(next);
  }
  return [...picked].sort((a,b)=>Number(a.caseId.split('_').at(-1))-Number(b.caseId.split('_').at(-1)));
}

function recordedTools(task:any, requestTools:Map<string,string>) {
  const messages=task.messages as any[];
  const declarations=messages.flatMap(m=>m.tool_calls??[]);
  const differences:{call:number;traceBytes:number;modelBytes:number;traceSha256:string;modelSha256:string}[]=[];
  const calls:ToolCall[]=task.snapshot.trace.map((entry:any,index:number)=>{
    const declaration=declarations[index];
    if(!declaration||declaration.function.name!==entry.tool_name||!isDeepStrictEqual(JSON.parse(declaration.function.arguments),entry.arguments))
      throw new Error('工具轨迹与模型调用不一致 '+task.taskId+'/'+(index+1));
    const trace=typeof entry.result==='string'?entry.result:JSON.stringify(entry.result);
    const model=requestTools.get(declaration.id);
    if(model!==undefined&&typeof model!=='string')throw new Error('工具消息不是字符串 '+task.taskId);
    if(model!==undefined&&model!==trace)differences.push({call:index+1,traceBytes:Buffer.byteLength(trace),
      modelBytes:Buffer.byteLength(model),traceSha256:sha(trace),modelSha256:sha(model)});
    return {name:entry.tool_name,arguments:entry.arguments,observation:model??trace};
  });
  if(calls.length!==task.toolCalls)throw new Error('工具轨迹数量不一致 '+task.taskId);
  return {calls,differences};
}

export async function buildReplayIndex(source:string,output:string,selection:string) {
  const dir=join(source,batch);
  const score=JSON.parse(await readFile(join(dir,'score.json'),'utf8'));
  const scores=new Map<string,any>(score.tasks.map((row:any)=>[row.taskId,row]));
  const cases=new Map<string,Case>();
  const files=new Map<string,string>();
  for(const file of (await readdir(join(dir,'tasks'))).sort()) {
    if(!file.endsWith('.json'))continue;
    const path=join(dir,'tasks',file),text=await readFile(path,'utf8'),task=JSON.parse(text);
    const graded=scores.get(task.taskId);
    if(!graded||cases.has(task.taskId)||files.has(task.caseId)||!Array.isArray(task.snapshot?.trace))throw new Error('旧任务身份、评分或轨迹无效 '+file);
    files.set(task.caseId,path);
    cases.set(task.taskId,{caseId:task.caseId,taskId:task.taskId,toolCalls:task.toolCalls,status:task.status,
      terminationReason:task.terminationReason,valid:graded.official_result?.valid,
      features:features(task,graded.official_result?.valid),redacted:text.includes(redaction)});
  }
  const positions=new Map<string,Position[]>();
  const scanned=await scan(source,(row,line,redacted)=>{
    const task=cases.get(row.taskId);
    if(!task)return;
    if(redacted)task.redacted=true;
    const steps=positions.get(row.taskId)??[];
    steps.push({started:row.startedEpochMs,line});positions.set(row.taskId,steps);
  });
  for(const task of cases.values())if(!positions.get(task.taskId)?.length)throw new Error('旧任务缺少模型记录 '+task.taskId);
  const selected=choose([...cases.values()],40);
  const selectedPositions=new Map<number,{task:Case;step:number}>();
  for(const task of selected) {
    const rows=positions.get(task.taskId)!.sort((a,b)=>a.started-b.started||a.line-b.line);
    for(const [index,row] of rows.entries())selectedPositions.set(row.line,{task,step:index+1});
  }
  // Stage before publication so a scan failure cannot leave an apparently complete index.
  const temporary=output+'.building';
  await mkdir(temporary);
  try {
    const records:Record<string,{file:string;sha256:string}>={};
    const requestTools=new Map<string,Map<string,string>>();
    const terminalModelRecords:string[]=[];
    const recordDir=join(temporary,'models','model-records');
    await mkdir(recordDir,{recursive:true});
    await mkdir(join(temporary,'tools'));
    let modelBytes=0,toolBytes=0;
    await scan(source,async(row,line,redacted)=>{
      const chosen=selectedPositions.get(line);
      if(!chosen)return;
      const {task,step}=chosen;
      if(redacted||row.taskId!==task.taskId||!row.request||!row.response||!/^[a-f0-9-]{36}$/.test(row.requestId))
        throw new Error('选定模型记录不完整 '+line);
      const key=positionKey(task.caseId,1,step),file=row.requestId+'.json';
      if(!row.settled)terminalModelRecords.push(key);
      const document:ReplayRecord={caseId:task.caseId,logicalTurn:1,logicalStep:step,requestBody:row.request,rawResponse:row.response};
      const payload=JSON.stringify(document)+'\n';
      await writeFile(join(recordDir,file),payload,{flag:'wx'});
      records[key]={file,sha256:sha(payload)};
      modelBytes+=Buffer.byteLength(payload);
      const observations=requestTools.get(task.caseId)??new Map<string,string>();
      requestTools.set(task.caseId,observations);
      for(const message of row.request.messages)if(message.role==='tool'&&!observations.has(message.tool_call_id))
        observations.set(message.tool_call_id,message.content);
    });
    if(Object.keys(records).length!==selectedPositions.size)throw new Error('回放索引缺少模型记录');
    const mismatches:{caseId:string;differences:ReturnType<typeof recordedTools>['differences']}[]=[];
    for(const task of selected) {
      const old=JSON.parse(await readFile(files.get(task.caseId)!,'utf8'));
      const {calls,differences}=recordedTools(old,requestTools.get(task.caseId)!);
      if(differences.length)mismatches.push({caseId:task.caseId,differences});
      const payload=JSON.stringify({caseId:task.caseId,calls})+'\n';
      await writeFile(join(temporary,'tools',task.caseId+'.json'),payload,{flag:'wx'});
      toolBytes+=Buffer.byteLength(payload);
      requestTools.delete(task.caseId);
    }
    const index={version:1,tasks:selected.map(c=>c.caseId),records:Object.fromEntries(Object.entries(records).sort(([a],[b])=>a.localeCompare(b)))};
    const summary={source:batch,scanned,cohort:cases.size,eligible:[...cases.values()].filter(c=>!c.redacted).length,
      selected:selected.length,positions:Object.keys(records).length,modelBytes,toolBytes,terminalModelRecords,mismatches};
    const proposal={status:'proposed',source:batch,seed,script:'scripts/build-replay-index.ts',rule:'Exclude redacted cases. Select min/max tool counts, cover named features, then round-robin across four tool-count strata in seeded hash order.',
      eligible:[...cases.values()].filter(c=>!c.redacted).map(c=>c.caseId),cases:selected};
    await writeFile(join(temporary,'models','index.json'),json(index),{flag:'wx'});
    await writeFile(join(temporary,'summary.json'),json(summary),{flag:'wx'});
    await rename(temporary,output);
    await writeFile(selection,json(proposal),{flag:'wx'});
    console.log(JSON.stringify(summary));return index;
  } catch(error) {
    // Only clean the directory this invocation created. The committed output is kept for diagnosis.
    console.error('Incomplete replay staging path (if present):',temporary);
    throw error;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const {values}=parseArgs({options:{source:{type:'string'},output:{type:'string',default:'data/replay'},
    selection:{type:'string',default:'config/web-replay-selection.json'}}});
  if(!values.source)throw new Error('需要 --source 指向旧 Web 正式运行目录');
  await buildReplayIndex(resolve(values.source),resolve(values.output!),resolve(values.selection!));
}
