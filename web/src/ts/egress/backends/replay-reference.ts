// Offline comparison uses the same request builder and byte functions as production.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inlineBytes } from '../../../../vendor/ditto/dist/worker/context/validation.js';
import { CONTEXT_POLICY } from '../../agent-core.ts';
import { loadActions } from '../../tool-actions.ts';
import { buildRequest, requestBodyBytes } from '../model.ts';
import { writeNew } from '../common.ts';
import type { ModelSettings } from '../model_config.ts';
import type { Message } from '../types.ts';
import { readReplayRecord, webRequestComparator } from './replay.ts';

interface ReferenceInput {
  source:string;
  index:string;
  tools:string;
  cases:string[];
  settings:ModelSettings;
}
interface RecordedCall {name:string;arguments:Record<string,unknown>;observation:string}
type DeclaredCall = Pick<RecordedCall, 'name'|'arguments'> & {id:string;turn:number;step:number};
const read = async (file:string) => JSON.parse(await readFile(file, 'utf8'));

export async function measureReplayReference(options:ReferenceInput) {
  const index = await read(options.index);
  const compare = await webRequestComparator();
  const byCase:Record<string,unknown> = {};
  for (const caseId of options.cases) {
    const recorded = await read(join(options.tools, caseId + '.json'));
    if (recorded.caseId !== caseId || !Array.isArray(recorded.calls)) throw new Error('回放工具记录无效：' + caseId);
    const positions = Object.keys(index.records).filter(p => p.startsWith(caseId + '/'))
      .sort((a, b) => Number(a.split('/')[2]) - Number(b.split('/')[2]));
    if (!positions.length) throw new Error('回放索引缺题：' + caseId);
    const requests = [];
    const declaredCalls:DeclaredCall[] = [];
    let oldEnd:unknown = null;
    for (const [i, position] of positions.entries()) {
      const step = i + 1;
      if (position !== `${caseId}/1/${step}`) throw new Error('回放模型位置不连续：' + position);
      const record = await readReplayRecord(options.source, position, index.records[position]);
      const messages = record.requestBody.messages.map((message:any):Message => {
        if (message.role === 'assistant') return {role:'assistant', content:message.content, metadata:{chatMessage:message}};
        if (message.role === 'tool') return {role:'tool', content:message.content, metadata:{actionRequestId:message.tool_call_id}};
        return {role:message.role, content:message.content};
      });
      const body = buildRequest({messages, actions:await loadActions(caseId, 1), model:{model:options.settings.model.model}}, options.settings);
      const differences = compare(record.requestBody, body);
      if (differences.length) throw new Error(`旧请求无法按新规则重建：${position} ${differences[0].path}`);
      requests.push({turn:1, step, bytes:requestBodyBytes(body)});
      const error = record.rawResponse?.error;
      if (error) {
        if (i !== positions.length - 1) throw new Error('模型错误记录位于题目中间：' + position);
        oldEnd = {turn:1, step, type:error.type, code:error.code,
          providerContext:typeof error.message === 'string' && /^This model's maximum context length is 1048576 tokens\./i.test(error.message)};
      }
      for (const call of record.rawResponse?.choices?.[0]?.message?.tool_calls ?? [])
        declaredCalls.push({id:call.id, turn:1, step, name:call.function.name, arguments:JSON.parse(call.function.arguments)});
    }
    const tools = recorded.calls.map((call:RecordedCall, index:number) => {
      const declared = declaredCalls[index];
      if (!declared || declared.name !== call.name || !isDeepStrictEqual(declared.arguments, call.arguments) ||
        typeof call.observation !== 'string') throw new Error(`旧工具与模型位置不一致：${caseId} #${index+1}`);
      return {...declared, bytes:inlineBytes(call.observation)};
    });
    byCase[caseId] = {requests, tools, oldEnd};
  }
  return {contextLimit:CONTEXT_POLICY.maxInlineBytes, requestLimit:options.settings.model.maxRequestBytes, byCase};
}

const input:Buffer[] = [];
for await (const chunk of process.stdin) input.push(chunk);
const output = process.argv[2];
if (!output) throw new Error('需要回放参照输出路径');
await writeNew(output, await measureReplayReference(JSON.parse(Buffer.concat(input).toString('utf8'))));
