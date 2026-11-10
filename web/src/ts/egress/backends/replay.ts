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
type RuleValue = {missing:true}|{value:unknown};
type Rule = {path:(string|number)[];old:RuleValue;new:RuleValue};
const whitelistUrl = new URL('./web-replay-request-differences.json', import.meta.url);

export async function webRequestComparator() {
  const rules:Rule[] = JSON.parse(await readFile(whitelistUrl, 'utf8'));
  return (old:any, current:any) => {
    const expected = structuredClone(old);
    const invalidOld = [];
    for (const rule of rules) {
      const parent = rule.path.slice(0, -1).reduce<any>((value, key) => value?.[key], expected);
      const key = rule.path.at(-1)!;
      const path = '$' + rule.path.map(part => typeof part === 'number' ? `[${part}]` : '.' + part).join('');
      const isParent = parent !== null && typeof parent === 'object';
      const missing = !isParent || !Object.hasOwn(parent, key);
      if (!isParent || ('missing' in rule.old ? !missing : missing || !isDeepStrictEqual(parent[key], rule.old.value))) {
        invalidOld.push({path, error:'旧请求白名单值不符'});
        continue;
      }
      if ('missing' in rule.new) delete parent[key];
      else parent[key] = rule.new.value;
    }
    return [...invalidOld, ...diffFields(expected, current)];
  };
}

export async function readReplayRecord(source:string, position:string, entry:{file:string;sha256:string}) {
  if(!/^[a-f0-9-]{36}\.json$/.test(entry.file))throw new Error('回放文件名无效');
  const bytes=await readFile(join(source,'model-records',entry.file));
  if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error(`回放记录哈希不符：${position}`);
  const old=JSON.parse(bytes.toString('utf8'));
  if(typeof old.caseId!=='string'||!Number.isSafeInteger(old.logicalTurn)||!Number.isSafeInteger(old.logicalStep)||
    positionKey(old.caseId,old.logicalTurn,old.logicalStep)!==position)throw new Error(`回放位置不符：${position}`);
  return old;
}
export async function replayBackend(options:{source:string;index:string;failOnDifference:boolean},output:string){
  const index=JSON.parse(await readFile(options.index,'utf8'));
  if(index.version!==1||!index.records)throw new Error('回放索引格式无效');
  const write=createJsonlWriter(join(output,'requests.jsonl'));
  const compareWeb = await webRequestComparator();
  return async(input:SampleInput,body:any,signal:AbortSignal)=>{
    signal.throwIfAborted();const {configId,taskId,caseId,turn,step}=input.metadata!;
    const position=positionKey(String(caseId),Number(turn),Number(step)),entry=index.records[position];
    if(!entry)throw new Error(`缺少回放记录：${position}`);
    const old=await readReplayRecord(options.source,position,entry);
    const differences=String(caseId).startsWith('web_search_no_snippet_')
      ? compareWeb(old.requestBody,body) : diffFields(old.requestBody,body);
    await write({configId,taskId,caseId,turn,step,position,source:entry,requestBody:body,differences});
    if(differences.length&&options.failOnDifference)throw new Error(`回放请求体不同：${position} ${differences[0].path}`);
    return old.rawResponse;
  };
}
