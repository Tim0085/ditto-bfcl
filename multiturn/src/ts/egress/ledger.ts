// 来源：experiments/bfcl_direct/src/ts/ledger.ts；T5：在途数参数化（默认81）；账本兼容追加 configId/caseId，其余记账规则保持。
// 单一父进程持有追加账本；重启只重放一次历史，不清空未结算费用。
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, relative, isAbsolute, win32 } from "node:path";
import type { Usage } from "./types.ts";
import type { ModelSettings } from "./model_config.ts";
import { digest } from "./common.ts";
export type TokenUsage = Required<Pick<Usage, "inputTokens" | "outputTokens" | "totalTokens">> & Pick<Usage, "cachedInputTokens" | "reasoningTokens">;
export type FailedRequestDetails = { reason: "transport_unknown"; source?: string };
export class BudgetAdmissionError extends Error {
  constructor(readonly reason: "usd" | "cny" | "requests", readonly pendingRequests: number, readonly accountingVersion: number) {
    super(reason === "cny" ? "人民币预算不足，尚未调用模型" : "预算或请求上限不足，尚未调用模型");
  }
}
export function checkUsage(value: Usage | undefined): TokenUsage {
  for (const k of ["inputTokens", "outputTokens", "totalTokens"] as const) if (!Number.isSafeInteger(value?.[k]) || value![k]! < 0) throw new Error("模型缺少有效用量");
  if (value!.totalTokens !== value!.inputTokens! + value!.outputTokens!) throw new Error("总用量不一致");
  for (const [key, total] of [["cachedInputTokens", "inputTokens"], ["reasoningTokens", "outputTokens"]] as const) {
    if (value![key] !== undefined && (!Number.isSafeInteger(value![key]) || value![key]! < 0 || value![key]! > value![total]!)) throw new Error("用量子项不一致");
  }
  return value as TokenUsage;
}
export class Ledger {
  private tail: Promise<unknown> = Promise.resolve();
  readonly pending = new Map<string, any>();
  readonly settlements = new Map<string, any>();
  readonly reservations = new Map<string, any>();
  readonly retained = new Map<string, any>();
  // 只影响已获准重做题目的当前尝试；预算始终保留原账全部请求及费用。
  readonly excludedRequestIds = new Set<string>();
  private unresolved = new Set<string>();
  private spent = 0;
  private spentCny = 0;
  private cny?: { limit: number; rates: { cachedInput: number; uncachedInput: number; output: number } };
  private blocked = false;
  private header: any;
  private accountingVersion = 0;
  private readonly accountingWaiters = new Set<() => void>();
  constructor(readonly path: string, readonly settings: ModelSettings, readonly source: string, readonly configHash: string, readonly maxInFlight = 81) {}
  cost(input: number, output: number) { return Math.ceil(input * this.settings.model.referencePrice.inputPerMillion + output * this.settings.model.referencePrice.outputPerMillion); }
  private costCny(input: number, output: number, cached = 0) {
    if (!this.cny) throw new Error("未配置人民币预算");
    const rates = this.cny.rates;
    const amount = Math.ceil((input - cached) * rates.uncachedInput + cached * rates.cachedInput + output * rates.output);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("人民币费用超出有效金额范围");
    return amount;
  }
  private apply(event: any) {
    if (event.kind === "reserve") {
      if (typeof event.id !== "string" || !event.id || typeof event.taskId !== "string" || !event.taskId || this.reservations.has(event.id)
          || !Number.isSafeInteger(event.microUsd) || event.microUsd < 1) throw new Error("重复请求或错误预留金额");
      if (event.reservedInputTokens !== undefined || event.reservedOutputTokens !== undefined) {
        if (![event.reservedInputTokens,event.reservedOutputTokens].every(n => Number.isSafeInteger(n) && n > 0)
            || event.microUsd !== this.cost(event.reservedInputTokens,event.reservedOutputTokens)) throw new Error("请求预留界限或金额不一致");
      }
      if (this.cny ? !Number.isSafeInteger(event.reservedInputTokens) || !Number.isSafeInteger(event.reservedOutputTokens)
          || event.microCny !== this.costCny(event.reservedInputTokens, event.reservedOutputTokens)
        : event.microCny !== undefined) throw new Error("人民币请求预留金额不一致");
      if (this.cny && this.spentCny + [...this.pending.values()].reduce((sum, e) => sum + e.microCny, 0)
          + [...this.retained.values()].reduce((sum, e) => sum + e.heldMicroCny, 0) + event.microCny > this.cny.limit)
        throw new Error("账本预留超过人民币预算");
      this.reservations.set(event.id, event); this.pending.set(event.id, event);
    } else if (event.kind === "settle") {
      const usage = checkUsage(event.usage);
      const reserved = this.pending.get(event.id), microUsd = this.cost(usage.inputTokens, usage.outputTokens);
      if (!reserved || event.microUsd !== microUsd || typeof event.overrun !== "boolean"
          || (microUsd > reserved.microUsd && !event.overrun)) throw new Error("结算缺少预留、费用或超限标志不匹配");
      if (this.cny ? event.microCny !== this.costCny(usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0)
        : event.microCny !== undefined) throw new Error("人民币结算金额不一致");
      if (reserved.reservedInputTokens !== undefined) {
        const overrun = usage.inputTokens > reserved.reservedInputTokens || usage.outputTokens > reserved.reservedOutputTokens;
        if (event.overrun !== overrun) throw new Error("结算超限标志与该次预留界限不一致");
      }
      // 旧事件没有逐项界限；保留原金额与超限标志，不用新输入配置改判历史。
      this.pending.delete(event.id); this.settlements.set(event.id, event); this.spent += event.microUsd;
      if (this.cny) this.spentCny += event.microCny;
      this.blocked ||= event.overrun;
    } else if (event.kind === "uncertain" && this.pending.has(event.id) && !this.unresolved.has(event.id)) this.unresolved.add(event.id);
    else if (event.kind === "retain_failed") {
      const reserved = this.pending.get(event.id);
      if (!reserved || event.reason !== "transport_unknown" || event.heldMicroUsd !== reserved.microUsd) throw new Error("失败请求缺少预留或保留金额不一致");
      if (this.cny ? event.heldMicroCny !== reserved.microCny : event.heldMicroCny !== undefined) throw new Error("人民币失败预留金额不一致");
      this.pending.delete(event.id); this.unresolved.delete(event.id); this.retained.set(event.id, event);
    }
    else throw new Error("账本事件不合法");
  }
  async open(existingOnly = false, allowUnresolved = false) {
    const {referenceCny, peakCnyPerMillion} = this.settings.budget;
    if (referenceCny !== undefined || peakCnyPerMillion !== undefined) {
      const rates = peakCnyPerMillion, limit = Math.floor(referenceCny! * 1e6);
      if (typeof referenceCny !== "number" || !Number.isFinite(referenceCny) || !Number.isSafeInteger(limit) || limit < 1
          || !rates || typeof rates !== "object" || Array.isArray(rates)
          || Object.keys(rates).sort().join() !== "cachedInput,output,uncachedInput"
          || !Object.values(rates).every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
          || rates.uncachedInput <= 0 || rates.output <= 0 || rates.cachedInput > rates.uncachedInput)
        throw new Error("人民币预算和峰价须成对配置有效上限与单价");
      this.cny = {limit, rates: structuredClone(rates)};
    }
    this.header = { kind: "header", configId: "__global__", version: 1, id: randomUUID(), source: this.source, configHash: this.configHash,
      referenceLimitMicroUsd: Math.floor(this.settings.budget.referenceUsd * 1e6), maxRequests: this.settings.budget.maxRequests,
      ...(this.cny ? {referenceLimitMicroCny: this.cny.limit, peakCnyPerMillion: this.cny.rates} : {}),
      note: this.source === "offline-reference" ? "synthetic usage and cost, not model billing" : "reference cost; provider invoice not verified" };
    let existing = existingOnly;
    if (!existingOnly) {
      try { await writeFile(this.path, JSON.stringify(this.header) + "\n", { flag: "wx", flush: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        existing = true;
      }
    }
    if (existing) {
      const text = await readFile(this.path, "utf8"); if (!text.endsWith("\n")) throw new Error("账本尾部不完整");
      const [header, ...events] = text.trimEnd().split("\n").map(line => JSON.parse(line));
      if (header.kind !== "header" || header.configHash !== this.configHash || header.source !== this.source
          || header.referenceLimitMicroUsd !== this.header.referenceLimitMicroUsd || header.maxRequests !== this.header.maxRequests) throw new Error("账本与本次配置不兼容");
      if (this.cny ? header.referenceLimitMicroCny !== this.cny.limit || !header.peakCnyPerMillion
          || Object.keys(header.peakCnyPerMillion).length !== 3
          || (["cachedInput","uncachedInput","output"] as const).some(key => header.peakCnyPerMillion[key] !== this.cny!.rates[key])
        : header.referenceLimitMicroCny !== undefined || header.peakCnyPerMillion !== undefined) throw new Error("人民币账本与本次配置不兼容");
      this.header = header; for (const event of events) this.apply(event);
    }
    await this.loadResearchExclusions();
    if (this.blocked || (!allowUnresolved && (this.pending.size || this.unresolved.size))) throw new Error("账本存在未结算/超限请求，拒绝自动重跑");
    return this;
  }
  private async loadResearchExclusions() {
    let manifest:any;
    try { manifest=JSON.parse(await readFile(join(dirname(this.path),"research-exclusions.json"),"utf8")); }
    catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT")return; throw error; }
    if(manifest?.version!==1||!Array.isArray(manifest.entries))throw new Error("旧尝试排除记录格式无效");
    const entryIds=new Set<string>();
    for(const entry of manifest.entries) {
      if(typeof entry.id!=="string"||!entry.id||entryIds.has(entry.id)||entry.authorizedBy!=="user"
          ||typeof entry.authorization!=="string"||!entry.authorization.trim()
          ||typeof entry.reason!=="string"||!entry.reason.trim()
          ||typeof entry.authorizedAt!=="string"||!/(Z|[+-]\d{2}:\d{2})$/.test(entry.authorizedAt)||!Number.isFinite(Date.parse(entry.authorizedAt))
          ||entry.unknownFeesRetained!==true||typeof entry.taskId!=="string"||!entry.taskId
          ||!Array.isArray(entry.requestIds)||!entry.requestIds.length)throw new Error("旧尝试缺少明确重跑授权");
      const archive=entry.archivePath;
      if(typeof archive!=="string"||!archive||isAbsolute(archive)||win32.parse(archive).root)throw new Error("旧尝试归档路径无效");
      const local=relative(dirname(this.path),resolve(dirname(this.path),archive));
      if(!local||local===".."||local.startsWith("../")||local.startsWith("..\\")||isAbsolute(local))throw new Error("旧尝试归档路径无效");
      entryIds.add(entry.id);
      for(const id of entry.requestIds) {
        if(typeof id!=="string"||this.excludedRequestIds.has(id)||this.reservations.get(id)?.taskId!==entry.taskId
            ||(!this.settlements.has(id)&&!this.retained.has(id)))throw new Error("旧尝试请求与原账或保留费用不一致");
        this.excludedRequestIds.add(id);
      }
    }
  }
  taskRequestIds(taskId:string) {
    return new Set([...this.reservations].filter(([id,row])=>row.taskId===taskId&&!this.excludedRequestIds.has(id)).map(([id])=>id));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => undefined); return result;
  }
  private async append(event: any) {
    event.configId ??= this.reservations.get(event.id)?.configId ?? "__global__";
    await appendFile(this.path, JSON.stringify(event) + "\n", { flush: true }); this.apply(event);
    if (["settle", "retain_failed", "uncertain"].includes(event.kind)) {
      this.accountingVersion++;
      for (const changed of [...this.accountingWaiters]) changed();
    }
  }
  waitForAccountingChange(version: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true;
        this.accountingWaiters.delete(changed); signal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const changed = () => finish();
      const aborted = () => finish(signal.reason instanceof Error && signal.reason.name === "TimeoutError"
        ? new Error("等待在途请求结算超时，尚未发送新请求") : new Error("请求入口已停止，取消等待结算"));
      this.accountingWaiters.add(changed); signal.addEventListener("abort", aborted, {once: true});
      if (signal.aborted) aborted(); else if (version !== this.accountingVersion) changed();
    });
  }
  snapshot() { return { ledgerId: this.header.id, source: this.source, configHash: this.configHash,
    requests: this.reservations.size, settled: this.settlements.size, spentMicroUsd: this.spent,
    reservedMicroUsd: [...this.pending.values()].reduce((sum, e) => sum + e.microUsd, 0),
    retainedMicroUsd: [...this.retained.values()].reduce((sum, e) => sum + e.heldMicroUsd, 0), retainedRequests: this.retained.size,
    ...(this.cny ? {limitMicroCny: this.cny.limit, spentMicroCny: this.spentCny,
      reservedMicroCny: [...this.pending.values()].reduce((sum, e) => sum + e.microCny, 0),
      retainedMicroCny: [...this.retained.values()].reduce((sum, e) => sum + e.heldMicroCny, 0)} : {}),
    blocked: this.blocked || this.unresolved.size > 0,
    limitMicroUsd: this.header.referenceLimitMicroUsd, maxRequests: this.header.maxRequests }; }
  reserve(taskId: string, reservedInputTokens = this.settings.model.maxInputTokens, identity?: {configId:string;caseId:string}) {
    return this.serial(async () => {
      const reservedOutputTokens = this.settings.model.maxOutputTokens;
      if (![reservedInputTokens,reservedOutputTokens].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("请求预留界限无效");
      const snapshot = this.snapshot(), amount = this.cost(reservedInputTokens, reservedOutputTokens);
      if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("请求预留金额无效");
      if (snapshot.blocked || this.pending.size >= this.maxInFlight) throw new Error("请求入口被停止或在途名额已满");
      if (snapshot.requests >= snapshot.maxRequests) throw new BudgetAdmissionError("requests", this.pending.size, this.accountingVersion);
      if (this.spent + snapshot.reservedMicroUsd + snapshot.retainedMicroUsd + amount > snapshot.limitMicroUsd)
        throw new BudgetAdmissionError("usd", this.pending.size, this.accountingVersion);
      const microCny = this.cny ? this.costCny(reservedInputTokens, reservedOutputTokens) : undefined;
      if (this.cny && this.spentCny + snapshot.reservedMicroCny! + snapshot.retainedMicroCny! + microCny! > this.cny.limit)
        throw new BudgetAdmissionError("cny", this.pending.size, this.accountingVersion);
      const id = randomUUID(); await this.append({ kind: "reserve", id, taskId, ...identity, microUsd: amount,
        ...(this.cny ? {microCny} : {}), reservedInputTokens, reservedOutputTokens }); return id;
    });
  }
  settle(id: string, usage: TokenUsage) {
    return this.serial(async () => {
      checkUsage(usage); if (!this.pending.has(id)) throw new Error("未知或重复结算");
      const microUsd = this.cost(usage.inputTokens, usage.outputTokens);
      const microCny = this.cny ? this.costCny(usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0) : undefined;
      const reserved = this.pending.get(id)!;
      const overrun = reserved.reservedInputTokens === undefined ? microUsd > reserved.microUsd
        : usage.inputTokens > reserved.reservedInputTokens || usage.outputTokens > reserved.reservedOutputTokens;
      await this.append({ kind: "settle", id, usage, microUsd, ...(this.cny ? {microCny} : {}), overrun });
      if (overrun) throw new Error("实际用量超过预留，已记费后停止");
      return { id, referenceMicroUsd: microUsd, ...(this.cny ? {referenceMicroCny: microCny} : {}) };
    });
  }
  uncertain(id: string) { return this.serial(async () => { if (this.pending.has(id) && !this.unresolved.has(id)) await this.append({ kind: "uncertain", id }); }); }
  retainFailedRequest(id: string, details: FailedRequestDetails) {
    return this.serial(async () => {
      const reserved = this.pending.get(id);
      if (!reserved || details.reason !== "transport_unknown") throw new Error("未知或重复保留的失败请求");
      const safe = { reason: details.reason,
        ...(typeof details.source === "string" && /^[a-zA-Z0-9_:-]{1,100}$/.test(details.source) ? { source: details.source } : {}) };
      // 用户显式恢复后仍占用原预留；没有用量，不能伪造结算或零费用。
      await this.append({ kind: "retain_failed", id, heldMicroUsd: reserved.microUsd,
        ...(this.cny ? {heldMicroCny: reserved.microCny} : {}), ...safe });
      return { id, heldReferenceMicroUsd: reserved.microUsd,
        ...(this.cny ? {heldReferenceMicroCny: reserved.microCny} : {}), reason: details.reason };
    });
  }
  verifyTask(task: any) {
    const used = new Set<string>();
    for (const step of task.modelSteps) {
      const receipt = step.output.message.metadata?.budgetReceipt, settled = this.settlements.get(receipt?.id), reserved = this.reservations.get(receipt?.id);
      if (!settled || !reserved || used.has(receipt.id) || this.excludedRequestIds.has(receipt.id) || reserved.taskId !== task.taskId
          || settled.microUsd !== receipt.referenceMicroUsd || digest(settled.usage) !== digest(step.output.usage)) throw new Error("已完成任务的费用记录与原账本不一致");
      if (this.cny && receipt.referenceMicroCny !== settled.microCny) throw new Error("任务人民币结算凭据不一致");
      used.add(receipt.id);
    }
    if (used.size !== task.usage.requests) throw new Error("任务与账本请求数不一致");
    for (const failure of task.failedModelAttempts ?? []) {
      const retained = this.retained.get(failure.id), reserved = this.reservations.get(failure.id);
      if (!retained || !reserved || used.has(failure.id) || this.excludedRequestIds.has(failure.id) || reserved.taskId !== task.taskId
          || failure.reason !== "transport_unknown" || failure.heldReferenceMicroUsd !== retained.heldMicroUsd) throw new Error("任务失败请求与保留账本不一致");
      if (this.cny && failure.heldReferenceMicroCny !== retained.heldMicroCny) throw new Error("任务人民币失败预留凭据不一致");
      used.add(failure.id);
    }
    if ((task.physicalModelRequests !== undefined && task.physicalModelRequests !== used.size)
        || ((task.failedModelAttempts?.length ?? 0) > 0 && task.physicalModelRequests !== used.size)
        || this.taskRequestIds(task.taskId).size !== used.size) throw new Error("任务与账本请求数不一致");
  }
}
