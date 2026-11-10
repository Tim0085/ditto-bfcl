// 来源：旧 bfcl_direct/src/ts/model_config.ts；仅复制题目/工具加载函数与所需类型；root 改为本包，去掉配置、凭据及模型代码。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, ActionDescriptor } from "@codesoul-co/ditto/worker/infer";
import { markFailure } from "./step-log.ts";
const root = fileURLToPath(new URL("../../", import.meta.url));
export const MULTI_TURN_CATEGORIES = ["multi_turn_base", "multi_turn_miss_func", "multi_turn_miss_param", "multi_turn_long_context"] as const;
export type Category = typeof MULTI_TURN_CATEGORIES[number];
export type Task = { id: string; question: Message[][]; involved_classes: string[]; excluded_function?: string[];
  missed_function?: Record<string, string[]>; initial_config: unknown };
export const toolFiles: Record<string, string> = { GorillaFileSystem: "gorilla_file_system", MathAPI: "math_api", MessageAPI: "message_api",
  TwitterAPI: "posting_api", TicketAPI: "ticket_api", TradingBot: "trading_bot", TravelAPI: "travel_booking", VehicleControlAPI: "vehicle_control" };
export function validateCategories(categories: readonly string[]): asserts categories is readonly Category[] {
  if(!Array.isArray(categories)||!categories.length||new Set(categories).size!==categories.length
      ||categories.some(category=>!(MULTI_TURN_CATEGORIES as readonly string[]).includes(category)))throw new Error("类别清单须为四种multi_turn类别的非空、不重复子集");
}
export function categoryOf(caseId:string):Category {
  const match=/^(multi_turn_(?:base|miss_func|miss_param|long_context))_(0|[1-9]\d*)$/.exec(caseId);
  if(!match||Number(match[2])>=200)throw new Error("未知multi_turn题号");
  return match[1] as Category;
}
export function categoryDataFile(category:Category,kind:"tasks"|"answers"|"fixtures") {
  return category==="multi_turn_base" ? `data/${kind==="fixtures"?"fixtures.json":kind+".jsonl"}`
    : `data/${category}.${kind}.${kind==="fixtures"?"json":"jsonl"}`;
}
const taskCache=new Map<Category,Task[]>();
export async function loadTasks(categories:readonly string[]=["multi_turn_base"]): Promise<Task[]> {
  try {
  validateCategories(categories);
  const output:Task[]=[];
  for(const category of categories) {
    let tasks=taskCache.get(category);
    if(!tasks) {
      tasks=(await readFile(join(root,categoryDataFile(category,"tasks")),"utf8")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      if(tasks.length!==200||new Set(tasks.map(t=>t.id)).size!==200||tasks.some(t=>categoryOf(t.id)!==category))throw new Error(category+"必须有200个不同题号");
      taskCache.set(category,tasks);
    }
    output.push(...tasks);
  }
  return output;
  }catch(error){throw markFailure(error,"other");}
}
export async function loadTask(caseId:string):Promise<Task> {
  try {
  const task=(await loadTasks([categoryOf(caseId)])).find(task=>task.id===caseId);
  if(!task)throw new Error("未知题号");return task;
  }catch(error){throw markFailure(error,"other");}
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
  try {
  const task = await loadTask(caseId);
  if(!Number.isSafeInteger(turn)||turn<1||turn>task.question.length)throw new Error("工具轮次超出题目范围");
  const docs = [];
  for (const className of task.involved_classes) {
    const filename = toolFiles[className]; if (!filename) throw new Error("未支持的官方环境");
    if (!docCache.has(filename)) docCache.set(filename, (await readFile(join(root, "data/tools", filename + ".json"), "utf8")).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)));
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
  }catch(error){throw markFailure(error,"other");}
}
