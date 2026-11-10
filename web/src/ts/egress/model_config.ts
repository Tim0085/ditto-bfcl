// 来源：experiments/bfcl_direct/src/ts/model_config.ts；T5：保留题目/工具/凭据函数，workerTimeouts按在途数推导；新出口配置入口是config.ts。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, ActionDescriptor } from "./types.ts";
import { root, readJson } from "./common.ts";
export { digest } from "./common.ts";

export type Profile = { protocol: "responses" | "chat-completions"; baseUrl: string; baseUrlEnv: string; apiKeyEnv: string;
  model: string; reasoningEffort: string; maxInputTokens: number; maxOutputTokens: number; timeoutMs: number;
  maxRequestBytes?: number;
  referencePrice: { inputPerMillion: number; outputPerMillion: number } };
export type ModelSettings = { profile: string; model: Profile; budget: { referenceUsd: number; maxRequests: number;
  referenceCny?: number; peakCnyPerMillion?: {cachedInput:number;uncachedInput:number;output:number} } };
import { WEB_CATEGORIES, WEB_PROFILE_NUMBERS, categoryOf, categoryDataFile, validateCategories, loadTasks, type Category } from "../tool-actions.ts";
export { categoryOf, categoryDataFile, validateCategories, loadTasks, type Category };
export const MULTI_TURN_CATEGORIES = WEB_CATEGORIES;

export type Task = { id: string; question: Message[][]; involved_classes: string[]; excluded_function?: string[];
  missed_function?: Record<string, string[]>; initial_config: unknown };
export type Backend = "direct" | "ditto";
export type DispatchPolicy = {maxInFlight:number;requestsPerMinute:number;minIntervalMs:number;maxCooldownMs:number};
export type Config = { version: 1; backend?: Backend; mode: "offline-reference" | "live"; workerCount: 4; groups: string[]; concurrencies: number[];
  caseIds: "all" | string[]; profileCases: string[]; perTaskRequests: number; requireCgroup: boolean; settings: ModelSettings;
  categories?: Category[]; condition?: "direct"|"monolithic"|"uniform"|"targeted"; dispatchPolicy?: DispatchPolicy;
  debug?: boolean; runtime?: Record<string, unknown>; retryPolicy?: {maxRetries:number} };
export { toolFiles } from "../tool-actions.ts";
import { toolFiles } from "../tool-actions.ts";
export async function loadConfig(path: string): Promise<Config> {
  const config = await readJson(path) as Config;
  if (config.version !== 1 || !["offline-reference", "live"].includes(config.mode) || config.workerCount !== 4
      || !Array.isArray(config.groups) || !Array.isArray(config.concurrencies)
      || (config.condition===undefined?config.concurrencies.join()!=="1,4":!config.concurrencies.length
        ||new Set(config.concurrencies).size!==config.concurrencies.length||config.concurrencies.some(value=>![1,4].includes(value)))) throw new Error("实验配置须为4个执行进程与并发1/4");
  if (config.backend !== undefined) {
    if (!["direct", "ditto"].includes(config.backend) || !config.groups.length || new Set(config.groups).size !== config.groups.length
        || config.groups.some(group=>!["monolithic","uniform","targeted"].includes(group)) || !Array.isArray(config.profileCases)
        || (config.backend === "direct" && (config.groups.join() !== "monolithic" || config.profileCases.length)))
      throw new Error("Direct只使用monolithic且不剖析；Ditto可选择三种Worker布局");
  } else if (config.groups.join() !== "monolithic,uniform,targeted") throw new Error("旧配置须保留原三组；新对照请明确backend");
  if(config.condition!==undefined) {
    const expectedBackend=config.condition==="direct"?"direct":"ditto",expectedGroup=config.condition==="direct"?"monolithic":config.condition;
    if(!["direct","monolithic","uniform","targeted"].includes(config.condition)||config.backend!==expectedBackend||config.groups.join()!==expectedGroup)
      throw new Error("condition必须与实际后端和单一Worker布局一致");
  }
  if (config.categories !== undefined) validateCategories(config.categories);
  const { model, budget } = config.settings;
  if (!model.model || !["responses", "chat-completions"].includes(model.protocol) || !model.reasoningEffort) throw new Error("模型设置不完整");
  if (model.model === "gpt-6.1-sol" && model.protocol !== "responses") throw new Error("当前GPT配置需要Responses协议");
  for (const n of [model.maxInputTokens, model.maxOutputTokens, model.timeoutMs, budget.maxRequests, config.perTaskRequests]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error("请明确有效的请求/token/超时上限；尚未发出模型请求");
  }
  if (model.maxRequestBytes !== undefined && (!Number.isSafeInteger(model.maxRequestBytes) || model.maxRequestBytes < 1)) throw new Error("maxRequestBytes 必须为正整数字节数");
  if (model.timeoutMs > 2147398647) throw new Error("模型超时超过系统定时器支持范围");
  if(config.retryPolicy!==undefined && (Object.keys(config.retryPolicy).join()!=="maxRetries"
      || !Number.isSafeInteger(config.retryPolicy.maxRetries)||config.retryPolicy.maxRetries<0||config.retryPolicy.maxRetries>2))throw new Error("retryPolicy只允许明确的0至2次重试");
  if (config.dispatchPolicy !== undefined) {
    const policy=config.dispatchPolicy;
    if (!policy || !Number.isSafeInteger(policy.maxInFlight) || policy.maxInFlight<1 || policy.maxInFlight>4
        || !Number.isSafeInteger(policy.requestsPerMinute) || policy.requestsPerMinute<1 || policy.requestsPerMinute>240
        || !Number.isSafeInteger(policy.minIntervalMs) || policy.minIntervalMs<Math.ceil(60000/policy.requestsPerMinute) || policy.minIntervalMs>60000
        || !Number.isSafeInteger(policy.maxCooldownMs) || policy.maxCooldownMs<1 || policy.maxCooldownMs>900000)
      throw new Error("发送策略须为1至4在途、1至240RPM、匹配的启动间隔和不超过15分钟冷却");
  }
  if(workerTimeouts(model.timeoutMs,config.retryPolicy?.maxRetries,config.dispatchPolicy).ipc>2147483647)throw new Error("重试后的外层超时超过系统定时器支持范围");
  for (const n of [budget.referenceUsd, model.referencePrice.inputPerMillion, model.referencePrice.outputPerMillion]) {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) throw new Error("请先确认并填写本次预算与参考价格；尚未发出模型请求");
  }
  if (budget.referenceCny !== undefined || budget.peakCnyPerMillion !== undefined) {
    const rate=budget.peakCnyPerMillion;
    if (typeof budget.referenceCny!=="number" || !Number.isFinite(budget.referenceCny) || budget.referenceCny<=0
        || !rate || Object.keys(rate).sort().join()!=="cachedInput,output,uncachedInput"
        || [rate.cachedInput,rate.uncachedInput,rate.output].some(value=>typeof value!=="number" || !Number.isFinite(value) || value<0)
        || rate.uncachedInput<=0 || rate.output<=0 || rate.cachedInput>rate.uncachedInput)
      throw new Error("人民币上限与峰价需同时配置为有效数值；缓存价不能高于非缓存输入价");
  }
  if (model.baseUrl !== "" || !/^[A-Z][A-Z0-9_]*$/.test(model.apiKeyEnv) || !/^[A-Z][A-Z0-9_]*$/.test(model.baseUrlEnv)) throw new Error("凭据只能使用环境变量，不能写进配置");
  config.debug ??= config.mode === "live";
  return config;
}
// 模型与题目决定实验条件；超时、预留量、日志和软件补丁只影响运行方式。
export function experimentConfig(config: Config) {
  const { maxInputTokens, maxRequestBytes, timeoutMs, baseUrl, baseUrlEnv, apiKeyEnv, ...model } = config.settings.model;
  const runtimeKeys = ["platform", "daemonPlatform", "emulated", "nodeVersion", "pythonVersion"];
  return { ...(config.backend !== undefined ? {backend:config.backend} : {}), mode: config.mode, workerCount: config.workerCount, groups: config.groups, concurrencies: config.concurrencies,
    caseIds: config.caseIds, profileCases: config.profileCases, perTaskRequests: config.perTaskRequests,
    requireCgroup: config.requireCgroup, ...(config.retryPolicy?{retryPolicy:config.retryPolicy}:{}),
    ...(config.categories?{categories:config.categories}:{}), ...(config.condition?{condition:config.condition}:{}),
    ...(config.dispatchPolicy?{dispatchPolicy:config.dispatchPolicy}:{}),
    settings: { profile: config.settings.profile, model, budget: config.settings.budget },
    runtime: Object.fromEntries(runtimeKeys.filter(key => config.runtime?.[key] !== undefined).map(key => [key,config.runtime![key]])) };
}
export function workerTimeouts(modelTimeoutMs: number, maxRetries=0, dispatchPolicy?: DispatchPolicy) {
  // 让外层超时覆盖模型请求及最多一分钟的全局限流等待，统一从一个配置推导。
  // 四个并发任务即使只允许一笔模型请求在途，也会在入口等待另外三个任务。
  // 预算等待与Worker外层共用该上限；按每个任务全部重试/冷却计算，避免正常排队先被外层终止。
  const slotWork=(maxRetries+1)*(modelTimeoutMs+(dispatchPolicy?.maxCooldownMs??0)+60000);
  // T5 数值放宽：按配置在途数覆盖其余请求的最坏等待，不再写死旧4份中的3份。
  const budgetWait=((dispatchPolicy?.maxInFlight??4)-1)*slotWork+60000,modelBridge=slotWork+budgetWait+10000;
  if(!Number.isSafeInteger(slotWork)||slotWork<1||!Number.isSafeInteger(modelBridge)||modelBridge+25000>2147483647)
    throw new Error("重试后的外层超时超过系统定时器支持范围");
  return {budgetWait,modelBridge,inference:modelBridge+15000,ipc:modelBridge+25000};
}
export function datasetLabel(caseId: string, profileCases: string[]) {
  if (profileCases.includes(caseId) || WEB_PROFILE_NUMBERS.includes(Number(caseId.split("_").at(-1)))) return "profile";
  return "unseen";
}
export function publicSettings(settings: ModelSettings) {
  const { baseUrl, baseUrlEnv, apiKeyEnv, ...model } = settings.model;
  return { profile: settings.profile, model, budget: settings.budget };
}
export function credentials(settings: ModelSettings, env = process.env) {
  const baseUrl = env[settings.model.baseUrlEnv]?.trim().replace(/\/+$/, ""), apiKey = env[settings.model.apiKeyEnv]?.trim();
  if (!baseUrl || !apiKey) throw new Error("请在私有环境文件填写API地址与密钥；尚未发出请求");
  let url: URL; try { url = new URL(baseUrl); } catch { throw new Error("API地址格式错误"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("API地址须为不含账号/查询参数的HTTPS基址");
  return { baseUrl, apiKey };
}
export async function loadTask(caseId:string):Promise<Task> {
  const task=(await loadTasks([categoryOf(caseId)])).find(task=>task.id===caseId);
  if(!task)throw new Error("未知题号");return task;
}
export function questionForTurn(task:Task,turn:number):Message[] {
  if(!Number.isSafeInteger(turn)||turn<1||turn>task.question.length)throw new Error("用户轮次超出题目范围");
  const question=task.question[turn-1];
  if(Object.hasOwn(task.missed_function??{},String(turn-1))) {
    if(question.length)throw new Error("官方补充工具轮必须为空用户消息");
    return [{role:"user",content:"I have updated some more functions you can choose from. What about now?"}];
  }
  return structuredClone(question);
}
const docCache = new Map<string, any[]>();
export function schema(value: any): any {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== "object") return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === "type" && typeof item === "string" ? ({ dict: "object", list: "array", float: "number" }[item] ?? item) : schema(item)]));
  if (out.type === "object") out.properties ??= {};
  return out;
}
export async function loadActions(caseId: string,turn=1): Promise<ActionDescriptor[]> {
  const task = await loadTask(caseId);
  if(!Number.isSafeInteger(turn)||turn<1||turn>task.question.length)throw new Error("工具轮次超出题目范围");
  const docs = [];
  for (const className of task.involved_classes) {
    const filename = toolFiles[className]; if (!filename) throw new Error("未支持的官方环境");
    if (!docCache.has(filename)) docCache.set(filename, (await readFile(join(root, "data/tools", filename), "utf8")).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)));
    docs.push(...docCache.get(filename)!);
  }
  const held=new Set(Object.values(task.missed_function??{}).flat());
  const available=docs.filter(doc=>!(task.excluded_function??[]).includes(doc.name)&&!held.has(doc.name));
  // 官方先从初始工具中移出缺失项，按开放轮次将相应文档追加到列表末尾。
  for(let index=0;index<turn;index++)for(const name of task.missed_function?.[String(index)]??[]) {
    const doc=docs.find(doc=>doc.name===name);
    if(!doc||available.some(item=>item.name===name)||(task.excluded_function??[]).includes(name))throw new Error("缺失工具开放清单与官方文档不一致");
    available.push(doc);
  }
  return available.map(doc => ({ name: doc.name, description: doc.description, inputSchema: schema(doc.parameters) }));
}
