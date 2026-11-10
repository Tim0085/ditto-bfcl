import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MemoryItem, MemoryStore } from "@codesoul-co/ditto/worker/memory";

/** 每个 taskId 一个 JSON 文件；只在一次操作期间读入，不常驻缓存。每个目录由一份 Worker 独占。 */
export function createMemoryStore(directory: string, policy: { restartOnFirstWrite?: boolean } = {}): MemoryStore & { releaseTask(taskId: string): Promise<void> } {
  let tail = Promise.resolve();
  // A rerun starts at turn one, not at a checkpoint. Keep the previous file
  // inspectable until the first successful WRITE atomically publishes this attempt.
  const writtenTasks = new Set<string>();
  const file = (taskId: string) => join(directory, createHash("sha256").update(taskId).digest("hex") + ".json");
  const taskForKey = (key?: string) => {
    if (!key || key.lastIndexOf("/") < 1 || key.endsWith("/")) throw new Error("记忆键必须包含题目编号/记录名");
    return key.slice(0, key.lastIndexOf("/"));
  };
  const taskForId = (id: string) => {
    const [encoded, uuid, extra] = id.split(".");
    if (!encoded || !uuid || extra !== undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error("记忆编号无效");
    return Buffer.from(encoded, "base64url").toString("utf8");
  };
  // GET/DELETE 的未知编号表示不存在；只有 UPDATE 缺失目标必须失败。
  const lookupTasks = (values: readonly string[], decode: (value: string) => string) => values.flatMap(value => {
    try { return [decode(value)]; } catch { return []; }
  });
  async function read(taskId: string): Promise<MemoryItem[]> {
    try { return JSON.parse(await readFile(file(taskId), "utf8")).memories; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function save(taskId: string, memories: MemoryItem[]) {
    const payload = { taskId, memories }, encoded = JSON.stringify(payload);
    // 文件只保存 JSON；拒绝会被序列化悄悄丢失/改变的值，避免重开后读到不同内容。
    if (!isDeepStrictEqual(JSON.parse(encoded),payload)) throw new Error("记忆内容必须能无损保存为 JSON");
    await mkdir(directory, { recursive: true });
    const target = file(taskId), temp = target + "." + randomUUID() + ".tmp";
    await writeFile(temp, encoded, { flag: "wx" });
    await rename(temp, target);
  }
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const result = tail.then(job); tail = result.then(() => {}, () => {}); return result;
  }
  const field = (item: unknown, path: string): unknown => path.split(".").reduce<unknown>((v,k) => v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined, item);
  return {
    releaseTask(taskId) { return serial(async () => { writtenTasks.delete(taskId); }); },
    get(input, options) { return serial(async () => {
      options?.signal?.throwIfAborted();
      const tasks = new Set([...lookupTasks(input.keys ?? [],taskForKey), ...lookupTasks(input.ids ?? [],taskForId)]);
      const found = (await Promise.all([...tasks].map(read))).flat();
      return found.filter(item => input.ids?.includes(item.id) || (item.key !== undefined && input.keys?.includes(item.key)));
    }); },
    query(input, options) { return serial(async () => {
      options?.signal?.throwIfAborted();
      let names: string[];
      try { names = (await readdir(directory)).filter(n => /^[0-9a-f]{64}\.json$/.test(n)).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
      let items: MemoryItem[] = [];
      for (const name of names) { options?.signal?.throwIfAborted(); items.push(...JSON.parse(await readFile(join(directory, name), "utf8")).memories); }
      items = items.filter(item => Object.entries(input.filter ?? {}).every(([k,v]) => isDeepStrictEqual(field(item,k),v)));
      for (const order of [...(input.orderBy ?? [])].reverse()) items.sort((a,b) => {
        const x = field(a,order.field), y = field(b,order.field);
        const sign = isDeepStrictEqual(x,y) ? 0 : (x as string | number) < (y as string | number) ? -1 : 1;
        return order.direction === "desc" ? -sign : sign;
      });
      const offset = input.cursor === undefined ? 0 : Number(input.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("记忆游标无效");
      const end = offset + (input.limit ?? 100);
      return { items: items.slice(offset,end), ...(end < items.length ? {nextCursor:String(end)} : {}) };
    }); },
    write(input, options) { return serial(async () => {
      options?.signal?.throwIfAborted();
      const tasks = new Map<string, MemoryItem[]>(), output: MemoryItem[] = [];
      for (const draft of input.memories) {
        const taskId = taskForKey(draft.key);
        if (!tasks.has(taskId)) tasks.set(taskId, policy.restartOnFirstWrite && !writtenTasks.has(taskId) ? [] : await read(taskId));
        const items = tasks.get(taskId)!;
        if (items.some(item => item.key === draft.key)) throw new Error("记忆键已存在，请使用 UPDATE");
        const item = { ...structuredClone(draft), id: Buffer.from(taskId).toString("base64url") + "." + randomUUID() };
        items.push(item); output.push(item);
      }
      options?.signal?.throwIfAborted();
      for (const [taskId, items] of tasks) { await save(taskId,items); writtenTasks.add(taskId); }
      return output;
    }); },
    update(input, options) { return serial(async () => {
      options?.signal?.throwIfAborted();
      const tasks = new Map<string, MemoryItem[]>(), output: MemoryItem[] = [];
      for (const patch of input.memories) {
        const taskId = taskForId(patch.id);
        if (!tasks.has(taskId)) tasks.set(taskId, await read(taskId));
        const items = tasks.get(taskId)!, index = items.findIndex(item => item.id === patch.id);
        if (index < 0) throw new Error("要更新的记忆不存在");
        items[index] = { ...items[index], ...structuredClone(patch) }; output.push(items[index]);
      }
      options?.signal?.throwIfAborted();
      for (const [taskId,items] of tasks) await save(taskId,items);
      return output;
    }); },
    delete(input, options) { return serial(async () => {
      options?.signal?.throwIfAborted();
      const deleted: string[] = [];
      for (const taskId of new Set(lookupTasks(input.ids,taskForId))) {
        const items = await read(taskId), remaining = items.filter(item => {
          if (!input.ids.includes(item.id)) return true;
          deleted.push(item.id); return false;
        });
        if (remaining.length !== items.length) { options?.signal?.throwIfAborted(); await save(taskId,remaining); }
      }
      return { deleted };
    }); },
  };
}
