import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createJsonlWriter } from '../common.ts';
import type { SampleInput } from '../types.ts';
export const positionKey=(caseId:string,turn:number,step:number)=>`${caseId}/${turn}/${step}`;
export function diffFields(old:any,current:any,path='$'):any[] {
  if(isDeepStrictEqual(old,current))return [];
  if(old&&current&&typeof old==='object'&&typeof current==='object'&&Array.isArray(old)===Array.isArray(current))
    return [...new Set([...Object.keys(old),...Object.keys(current)])].sort().flatMap(key=>diffFields(old[key],current[key],`${path}.${key}`));
  return [{path,...(old===undefined?{oldMissing:true}:{old}),...(current===undefined?{newMissing:true}:{new:current})}];
}
export async function replayBackend(options:{source:string;index:string;failOnDifference:boolean},output:string){
  const index=JSON.parse(await readFile(options.index,'utf8'));
  if(index.version!==1||!index.records)throw new Error('回放索引格式无效');
  const write=createJsonlWriter(join(output,'requests.jsonl'));
  return async(input:SampleInput,body:any,signal:AbortSignal)=>{
    signal.throwIfAborted();const {configId,taskId,caseId,turn,step}=input.metadata!;
    const position=positionKey(String(caseId),Number(turn),Number(step)),entry=index.records[position];
    if(!entry)throw new Error(`缺少回放记录：${position}`);
    if(!/^[a-f0-9-]{36}\.json$/.test(entry.file))throw new Error('回放文件名无效');
    const bytes=await readFile(join(options.source,'model-records',entry.file));
    if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error(`回放记录哈希不符：${position}`);
    const old=JSON.parse(bytes.toString('utf8'));
    if(old.caseId!==caseId||old.logicalTurn!==turn||old.logicalStep!==step)throw new Error(`回放位置不符：${position}`);
    const differences=diffFields(old.requestBody,body);
    await write({configId,taskId,caseId,turn,step,position,source:entry,requestBody:body,differences});
    if(differences.length&&options.failOnDifference)throw new Error(`回放请求体不同：${position} ${differences[0].path}`);
    return old.rawResponse;
  };
}
