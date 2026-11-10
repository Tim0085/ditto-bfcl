// 来源：experiments/bfcl_direct/src/ts/common.ts；T5：只调整 root 深度，指向新包。
import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile, mkdir, link, unlink, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../" : "../../", import.meta.url));
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const fileHash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
export const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
export async function stopOnFailure<T>(stop: () => Promise<void>, action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { await stop(); throw error; }
}
export function createJsonlWriter(path: string) {
  // 所有并发任务共用队列；上一笔完成写入和刷盘后才写下一笔。失败后不再追加。
  let tail = Promise.resolve();
  return (value: unknown) => {
    const line = JSON.stringify(value) + "\n";
    const operation = tail.then(() => appendFile(path, line, { flush: true }));
    tail = operation;
    void operation.catch(() => {}); // 调用方仍收到原错误；队列保留失败状态。
    return operation;
  };
}
export function taskSummary(task: any, sha256: string) {
  const serviceEvents=[...task.workerEvents,...(task.requestLimitEvents??[]),...(task.inputLimitEvents??[])];
  return {taskId:task.taskId,caseId:task.caseId,status:task.status,file:'tasks/'+task.caseId+'.json',sha256,usage:task.usage,
    ...(task.executionOutcome ? {executionOutcome:task.executionOutcome} : {}),
    ...(task.physicalModelRequests !== undefined ? {physicalModelRequests:task.physicalModelRequests} : {}),
    ...(task.failedModelAttempts?.length ? {failedModelAttempts:task.failedModelAttempts,performanceComparable:false} : {}),
    elapsedSeconds:task.elapsedSeconds,sojournSeconds:task.sojournSeconds,involvedClasses:task.involvedClasses,
    serviceMs:{infer:serviceEvents.filter((e:any)=>e.kind==='infer').reduce((n:number,e:any)=>n+e.serviceMs,0),
      tool:serviceEvents.filter((e:any)=>e.kind==='tool'&&e.action==='call').reduce((n:number,e:any)=>n+e.serviceMs,0)}};
}
export async function writeNew(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".writing";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true });
  try { await link(temporary, path); } finally { await unlink(temporary); }
}
export function progressWriter(path: string) {
  let tail = Promise.resolve(), warned = false;
  return (value: unknown) => {
    tail = tail.then(async () => {
      const temporary = path + ".tmp";
      await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
      await rename(temporary, path);
    }).catch(() => { if (!warned) console.warn("进度文件暂时无法更新，任务仍按原记录执行。"); warned = true; });
    return tail;
  };
}
export async function experimentFiles(offline: boolean,categories:readonly string[]=["multi_turn_base"]) {
  // 只识别题目、工具和官方评分版本，不把程序补丁与日志脚本当成新实验。
  const official = await readJson(join(root, "vendor/bfcl-source.json"));
  const names = new Set<string>(["data/tasks.jsonl", "config/prompt.json", "vendor/bfcl-source.json",
    ...official.files.map((item: any) => item.path).filter((name: string) => offline || name !== "data/answers.jsonl")]);
  for(const category of categories)if(category!=="multi_turn_base") {
    if(!["multi_turn_miss_func","multi_turn_miss_param","multi_turn_long_context"].includes(category))throw new Error("未知multi_turn类别");
    names.add(`data/${category}.tasks.jsonl`);
    if(offline) {names.add(`data/${category}.answers.jsonl`);names.add(`data/${category}.fixtures.json`);}
    names.add("vendor/multiturn-source.json");
  }
  const files: Record<string,string> = {};
  for (const name of [...names].sort()) files[name] = await fileHash(join(root,name));
  return files;
}
export async function sourceHash(offline: boolean, backend: "direct" | "ditto" = "ditto",categories:readonly string[]=["multi_turn_base"]) {
  const files: Record<string, string> = {};
  async function visit(relative: string) {
    for (const item of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === "__pycache__") continue;
      const name = relative + "/" + item.name;
      if (item.isDirectory()) await visit(name);
      else if (item.isFile()) files[name] = await fileHash(join(root, name));
    }
  }
  for (const folder of ["src", "scripts", "deploy", "vendor", "data/tools", ...(backend === "ditto" ? ["node_modules/@codesoul-co/ditto"] : []), "node_modules/yaml", ...(!import.meta.url.endsWith(".ts") ? ["dist"] : [])]) await visit(folder);
  files["package.json"] = await fileHash(join(root, "package.json"));
  for (const name of ["data/tasks.jsonl", "config/prompt.json", ...(offline ? ["data/fixtures.json", "data/answers.jsonl"] : [])]) files[name] = await fileHash(join(root, name));
  for(const category of categories)if(category!=="multi_turn_base") {
    if(!["multi_turn_miss_func","multi_turn_miss_param","multi_turn_long_context"].includes(category))throw new Error("未知multi_turn类别");
    for(const name of [`data/${category}.tasks.jsonl`,...(offline?[`data/${category}.fixtures.json`,`data/${category}.answers.jsonl`]:[])])files[name]=await fileHash(join(root,name));
  }
  return { hash: digest(files), files };
}
