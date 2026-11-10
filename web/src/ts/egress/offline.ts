// 来源：experiments/bfcl_direct/src/ts/offline.ts；T5：保持原逻辑；相邻模块来自本目录的独立副本。
// 仅离线入口加载参考夹具；按完整模型请求匹配，禁止网络回退。
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import type { Message, SampleOutput } from "./types.ts";
import { root, readJson } from "./common.ts";
import { buildRequest, parseResponse, modelSystem } from "./model.ts";
import { loadActions, loadTask, loadTasks, categoryOf, categoryDataFile, questionForTurn, type ModelSettings, type Category } from "./model_config.ts";
import { mockResponse } from "./mock.ts";
export function assistantMessage(output: SampleOutput): Message {
  return { ...output.message, ...(output.actionRequests?.length ? { metadata: { ...output.message.metadata, actionRequests: output.actionRequests } } : {}) };
}
export function toolMessage(id: string, name: string, observation: string): Message {
  return { role: "tool", content: observation, metadata: { actionRequestId: id, name } };
}
export async function offlineTransport(settings: ModelSettings) {
  const fixtureCache=new Map<Category,Map<string,any>>();
  async function caseFixture(caseId:string) {
    const category=categoryOf(caseId);
    if(!fixtureCache.has(category)) {
      const fixture=await readJson(join(root,categoryDataFile(category,"fixtures")));
      const expected=new Set((await loadTasks([category])).map(task=>task.id));
      const actual=new Set(fixture.cases.map((item:any)=>item.id));
      if(fixture.source!=="offline-reference"||fixture.cases.length!==expected.size||actual.size!==expected.size
          ||[...expected].some(id=>!actual.has(id)))throw new Error("缺少完整离线夹具："+category);
      fixtureCache.set(category,new Map(fixture.cases.map((task:any)=>[task.id,task])));
    }
    const task=fixtureCache.get(category)!.get(caseId);if(!task)throw new Error("未知离线题号");return task;
  }
  // Build one task at a time; completed tasks do not retain every large request body.
  const cache = new Map<string, { body: any; raw: any }[]>();
  async function forCase(caseId: string) {
    if (cache.has(caseId)) return cache.get(caseId)!;
    const task:any=await caseFixture(caseId),definition=await loadTask(caseId);
    if(!isDeepStrictEqual(task.question,definition.question)||task.turns.length!==definition.question.length)throw new Error("离线夹具与题目轮次不一致");
    let actions = await loadActions(caseId);
    const messages: Message[] = [structuredClone(modelSystem)], entries: { body: any; raw: any }[] = [];
    let index = 0;
    function add(output: SampleOutput) {
      const body = buildRequest({ messages, actions, model: { model: settings.model.model } }, settings);
      const raw = mockResponse(output, settings.model.model, settings.model.protocol, index++);
      entries.push({ body, raw }); messages.push(assistantMessage(parseResponse(raw, settings.model.protocol)));
    }
    for(let turn=0;turn<task.question.length;turn++) {
      actions=await loadActions(caseId,turn+1);
      messages.push(...questionForTurn(definition,turn+1));
      task.turns[turn].forEach((call: any, step: number) => {
        const id = `${caseId}-${turn+1}-${step+1}`;
        add({ message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id, name: call.name, arguments: call.arguments }] });
        messages.push(toolMessage(id, call.name, call.observation));
      });
      add({ message: { role: "assistant", content: `Turn ${turn+1} complete.` }, finishReason: "stop" });
    }
    cache.set(caseId, entries); return entries;
  }
  return { async invoke(caseId: string, body: any, signal: AbortSignal) {
    signal.throwIfAborted();
    const entry = (await forCase(caseId)).find(e => isDeepStrictEqual(e.body, body));
    if (!entry) throw new Error(`离线模型请求或工具观察不匹配：${caseId}；未访问网络`);
    return structuredClone(entry.raw);
  }, release(caseId: string) { cache.delete(caseId); } };
}
