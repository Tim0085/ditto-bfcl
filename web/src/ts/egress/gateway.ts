// 来源：experiments/bfcl_direct/src/ts/gateway.ts；T5：独立出口单写者锁与注入后端；保留旧预算/解析/重试流程；添加configId与同题并发/归属检查；无重试时也执行每题上限。
// 唯一父进程统一限流和记账；离线响应与真实HTTP使用同一协议解析。
import { readFile } from "node:fs/promises";
import { openSync, closeSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SampleInput } from "./types.ts";
import { buildRequest, requestBodyBytes, parseUsage, checkReturnedModel, parseResponse, ModelTransportError, ModelOutputFailure } from "./model.ts";
import { Ledger, BudgetAdmissionError } from "./ledger.ts";
import { GlobalLimiter, type Clock } from "./limiter.ts";
import { workerTimeouts } from "./model_config.ts";
import type { EgressConfig as Config } from "./config.ts";
import { digest } from "./common.ts";
import { writeNew } from "./common.ts";
import { PhysicalRequestLimit, InputLimit, temporaryModelFailure, retryDelayMs, providerContextLimit, type FailedModelAttempt } from "./retry.ts";
export class Gateway {
  stopped = false;
  firstFailure?: unknown;
  private active = 0;
  private captureWarned = false;
  private readonly captureSecret: string;
  private readonly budgetWaitController = new AbortController();
  get stopSignal() { return this.budgetWaitController.signal; }
  peak = 0;
  private readonly activeTasks = new Set<string>();
  private constructor(readonly ledger: Ledger, readonly limiter: GlobalLimiter, readonly config: Config, readonly output: string,
    readonly transport: (input: SampleInput, body: any, signal: AbortSignal) => Promise<any>, readonly releaseFixture: (id: string) => void,
    readonly requestStarts: Map<string, number>,private sharedLock?:{path:string;fd:number}) {
    this.captureSecret = ""; // 只在显式 live 适配器内读取凭据，原始响应由适配器脱敏。
  }
  private async capture(reservation: string, record: unknown) {
    if (!this.config.debug) return;
    // 辅助原始记录独立落盘；密钥只用于脱敏，写入失败不影响必要的费用结算。
    try {
      let text = JSON.stringify(record);
      if (this.captureSecret) text = text.split(JSON.stringify(this.captureSecret).slice(1, -1)).join("[REDACTED]");
      await writeNew(join(this.output, "model-records", reservation + ".json"), JSON.parse(text));
    } catch {
      if (!this.captureWarned) console.warn("部分模型原始记录无法保存，答题和费用结算继续；后续不重复提示。");
      this.captureWarned = true;
    }
  }
  static async open(output: string, config: Config, transport: Gateway["transport"], clock?: Clock) {
    const path=join(output,"gateway.lock");
    const sharedLock={path,fd:openSync(path,"wx")};
    try {
      try {await readFile(join(output,"stopped.json"),"utf8");throw new Error("出口已有停止记录，拒绝自动续跑");}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      const ledger=await new Ledger(join(output,"ledger.jsonl"),config.settings,config.mode,digest(config),config.dispatchPolicy.maxInFlight).open();
      let rateText="";
      try {rateText=await readFile(join(output,"rate.jsonl"),"utf8");}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      if(rateText&&!rateText.endsWith("\n"))throw new Error("历史限流记录不完整");
      const starts=rateText.split("\n").filter(Boolean).map(line=>JSON.parse(line)),ids=[...ledger.reservations.keys()];
      if(starts.length!==ids.length||starts.some((s,i)=>s.id!==ids[i]||!Number.isSafeInteger(s.at)||s.at<0))throw new Error("历史限流ID或时间与账本不一致");
      const limiter=new GlobalLimiter(join(output,"rate.jsonl"),clock,config.dispatchPolicy);await limiter.load();
      return new Gateway(ledger,limiter,config,output,transport,()=>{},new Map(starts.map(s=>[s.id,s.at])),sharedLock);
    } catch(error){closeSync(sharedLock.fd);unlinkSync(sharedLock.path);throw error;}
  }
  async invoke(input: SampleInput, signal?:AbortSignal) {
    if (this.stopped) throw new Error("模型入口已停止");
    let id: string | undefined, settled = false;
    const configId=input.metadata?.configId, activeTask=String(input.metadata?.taskId);
    let ownsTask=false;
    // 取消不仅打断HTTP，还要立即唤醒在途名额、限流、冷却、预算等待；按整轮停止处理。
    const cancelled=()=>{void this.halt().catch(()=>{});};
    signal?.addEventListener('abort',cancelled,{once:true});
    const maxRetries=this.config.retryPolicy?.maxRetries??0;
    const failures:FailedModelAttempt[]=[];
    try {
      const taskId = input.metadata?.taskId, caseId = input.metadata?.caseId;
      signal?.throwIfAborted();
      if (typeof taskId !== "string" || typeof caseId !== "string" || input.model.model !== this.config.settings.model.model) throw new Error("模型/任务身份不匹配");
      if(typeof configId!=="string"||!configId||this.activeTasks.has(activeTask))throw new Error("配置身份缺失或同题并发请求");
      for(const row of this.ledger.reservations.values())if(row.taskId===taskId&&(row.configId!==configId||row.caseId!==caseId))throw new Error("任务归属身份不一致");
      this.activeTasks.add(activeTask); ownsTask=true;
      const body = buildRequest(input, this.config.settings);
      const bodyBytes = requestBodyBytes(body), maxRequestBytes = this.config.settings.model.maxRequestBytes ?? 8 * 1024 * 1024;
      if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new Error("请求体独立字节上限配置无效，尚未调用模型");
      if (bodyBytes > maxRequestBytes) throw new InputLimit(bodyBytes, maxRequestBytes);
      const reservedInputTokens = Math.max(this.config.settings.model.maxInputTokens, bodyBytes + 1024);
      const physicalRequests=()=>this.ledger.taskRequestIds(taskId).size;
      let budgetWaitMs = 0;
      let budgetWaitDeadline: number | undefined;
      let retryNotBefore: number | undefined;
      for(;;) {
        const attempt=failures.length;
        if(this.stopped)throw new Error("模型入口已停止");
        signal?.throwIfAborted();
        if(physicalRequests()>=this.config.perTaskRequests)throw new PhysicalRequestLimit(failures,physicalRequests(),budgetWaitMs);
        id=undefined;settled=false;
        let retryable=false;
        try {
          return await this.limiter.execute(async () => { signal?.throwIfAborted(); id = await this.ledger.reserve(taskId, reservedInputTokens, {configId,caseId}); return id; }, async (reservation, waitMs, at) => {
            this.requestStarts.set(reservation, at);
            this.active++; this.peak = Math.max(this.peak, this.active);
            const start = performance.now(), requestStartedAt = Date.now();
            let raw: any, apiMs: number | undefined, responseReceivedAt: number | undefined, errorCategory: string | undefined = "transport";
            let transportFailure: ModelTransportError["safeDetails"] | undefined,requestedRetryDelayMs:number|undefined;
            try {
              raw = await this.transport(input, body, AbortSignal.any([AbortSignal.timeout(this.config.settings.model.timeoutMs),...(signal?[signal]:[])]));
              apiMs = performance.now() - start; responseReceivedAt = Date.now();
              errorCategory = "usage";
              const usage = parseUsage(raw, this.config.settings.model.protocol);
              errorCategory = "accounting";
              const receipt = await this.ledger.settle(reservation, usage); settled = true;
              errorCategory = "model_identity";
              checkReturnedModel(raw, this.config.settings.model.model);
              errorCategory = "response";
              let result;
              try { result = parseResponse(raw, this.config.settings.model.protocol); }
              catch (error) {
                if (!(error instanceof ModelOutputFailure)) throw error;
                result = {message:{role:"assistant" as const,content:"",metadata:{bfclTaskFailure:{reason:"model_output",code:error.detailCode}}},
                  finishReason:"error" as const,actionRequests:[]};
              }
              result.usage = usage;
              result.message.metadata = { ...result.message.metadata, budgetReceipt: receipt,
                ...(failures.length?{failedModelAttempts:structuredClone(failures)}:{}),
                modelTiming: { apiMs, requestStartedAt: at, rateWaitMs: this.config.mode === "live" ? waitMs : 0,
                  ...(budgetWaitMs ? {budgetWaitMs} : {}),
                  simulatedRateWaitMs: this.config.mode === "offline-reference" ? waitMs : undefined,
                  ...(failures.length?{retryApiMs:failures.reduce((n,f)=>n+f.apiMs,0),retryRateWaitMs:failures.reduce((n,f)=>n+f.rateWaitMs,0),physicalAttempts:failures.length+1}:{}) } };
              if (result.finishReason !== "error") errorCategory = undefined;
              return result;
            } catch(error) {
              apiMs ??= performance.now() - start;
              if(error instanceof ModelTransportError)transportFailure=error.safeDetails;
              if (errorCategory === 'transport' && this.config.mode === 'live' && this.config.settings.profile === 'deepseek' && providerContextLimit(error)) {
                await this.ledger.retainFailedRequest(reservation,{reason:'transport_unknown',source:'provider_context_limit'});
                throw new InputLimit(bodyBytes, maxRequestBytes, true);
              }
              retryable=this.config.dispatchPolicy?errorCategory==="transport"&&temporaryModelFailure(error)
                :errorCategory==="transport"||errorCategory==="usage";
              if(this.config.dispatchPolicy&&retryable&&attempt<maxRetries)requestedRetryDelayMs=retryDelayMs(error,attempt);
              if(maxRetries && retryable && this.ledger.pending.has(reservation)) {
                // 每次真实尝试都占用原预留；未知费用不伪造为0，也不复用同一个请求ID。
                const held=await this.ledger.retainFailedRequest(reservation,{reason:"transport_unknown",source:"bounded_retry"});
                failures.push({...held,apiMs,requestStartedAt:at,rateWaitMs:this.config.mode==="live"?waitMs:0,errorCategory:errorCategory!,
                  ...(requestedRetryDelayMs!==undefined?{retryDelayMs:requestedRetryDelayMs}:{}),
                  ...(transportFailure?{transportFailure}:{}),
                  ...(Number.isSafeInteger(input.metadata?.turn)?{turn:Number(input.metadata!.turn)}:{}),
                  ...(Number.isSafeInteger(input.metadata?.step)?{step:Number(input.metadata!.step)}:{})});
              }
              throw error;
            } finally {
              apiMs ??= performance.now() - start;
              await this.capture(reservation, { configId, backend: this.config.backend ?? "ditto", reservationId: reservation, taskId, caseId,
                protocol: this.config.settings.model.protocol, model: this.config.settings.model.model,
                requestStartedAt, rateRecordedAt: at, responseReceivedAt, apiMs,
                rateWaitMs:this.config.mode==="live"?waitMs:0,requestBody: body, rawResponse: raw,
                logicalTurn:input.metadata?.turn,logicalStep:input.metadata?.step,retryAttempt:attempt,
                ...(requestedRetryDelayMs!==undefined?{retryDelayMs:requestedRetryDelayMs}:{}),
                status: errorCategory ? "failed" : "completed", errorCategory, transportFailure,
                ledgerSettled: this.ledger.settlements.has(reservation), ledgerRetained:this.ledger.retained.has(reservation) });
              this.active--;
            }
          }, configId, retryNotBefore);
        } catch(error) {
          if(maxRetries && retryable && physicalRequests()>=this.config.perTaskRequests) {
            // 第三次失败也可能恰好耗尽本题40次；单题限额优先，不中止其他题。
            throw new PhysicalRequestLimit(failures,physicalRequests(),budgetWaitMs);
          }
          if(id===undefined && error instanceof BudgetAdmissionError && error.reason!=="requests"
              && error.pendingRequests>0 && !this.stopped) {
            // 先等待其他在途请求结算，再在原额度里复查；不建立预留，不发送HTTP。
            const started = performance.now();
            const limit = workerTimeouts(this.config.settings.model.timeoutMs, maxRetries, this.config.dispatchPolicy).budgetWait;
            budgetWaitDeadline ??= started + limit;
            const remaining = Math.ceil(budgetWaitDeadline - started);
            if (remaining <= 0) throw new Error("等待在途请求结算超时，尚未发送新请求");
            const waitSignal = AbortSignal.any([this.budgetWaitController.signal, AbortSignal.timeout(remaining),...(signal?[signal]:[])]);
            await this.ledger.waitForAccountingChange(error.accountingVersion, waitSignal);
            budgetWaitMs += performance.now() - started;
            continue;
          }
          if(maxRetries && retryable && attempt<maxRetries && !this.stopped){
            if(this.config.dispatchPolicy){
              const delay=retryDelayMs(error,attempt);
              const reason=error instanceof ModelTransportError&&error.safeDetails.httpStatus===429?'http_429':'transport';
              retryNotBefore=await this.limiter.cooldown(delay,id!,reason,configId);
            }
            continue;
          }
          if(maxRetries && retryable) {
            try {await writeNew(join(this.output,"retry-exhausted.json"),{configId,taskId,caseId,at:Date.now(),maxRetries,
              attempts:attempt+1,failedModelAttempts:failures});}
            catch(writeError){if((writeError as NodeJS.ErrnoException).code!=="EEXIST")throw writeError;}
          }
          throw error;
        }
      }
    } catch (error) {
      // 达到单题物理请求上限只结束本题，其他题继续；不是模型回答。
      if(error instanceof PhysicalRequestLimit || error instanceof InputLimit)throw error;
      // 先保存本入口的根异常，再通知其他并发请求停止；外部工具故障后的连带停止不抢占原因。
      if (!this.stopped) this.firstFailure ??= error;
      this.stopped = true; this.limiter.stop(); if (id && !settled && this.ledger.pending.has(id)) await this.ledger.uncertain(id);
      await this.halt(); throw error;
    } finally { signal?.removeEventListener('abort',cancelled);if(ownsTask)this.activeTasks.delete(activeTask); }
  }
  // T8a fix 6: halts are serialized inside this process; concurrent callers share one marker write.
  private halting?: Promise<void>;
  async halt(reason?: string) {
    this.stopped = true; this.limiter.stop(); this.budgetWaitController.abort();
    this.halting ??= this.writeStopMarker(reason).catch(error => { this.halting = undefined; throw error; });
    return this.halting;
  }
  private async writeStopMarker(reason?: string) {
    const marker = join(this.output, "stopped.json"), temporary = marker + ".writing";
    for (let attempt = 0; ; attempt++) {
      try { await writeNew(marker, { configId: "__global__", reason: "execution_stopped", at: Date.now(), ...(reason ? {detail: reason} : {}) }); return; }
      catch (error) {
        // Done only once the marker itself is published; never return without it.
        if (existsSync(marker)) return;
        const code = (error as NodeJS.ErrnoException).code;
        // Only this process holds gateway.lock and halts are serialized, so a temporary file
        // still present here is a stale leftover (e.g. from a crashed earlier process).
        if (code === "EEXIST" && existsSync(temporary)) { try { unlinkSync(temporary); } catch {} }
        // Windows: a file whose last handle is closing is briefly delete-pending.
        else if (!["EPERM", "EBUSY", "EBADF", "EACCES"].includes(code ?? "")) throw error;
        if (attempt >= 4) throw error;
        await new Promise(done => setTimeout(done, 20 * (attempt + 1)));
      }
    }
  }
  close() { this.stopped = true; this.limiter.stop(); this.budgetWaitController.abort();if(this.sharedLock){const lock=this.sharedLock;this.sharedLock=undefined;closeSync(lock.fd);unlinkSync(lock.path);} }
  verifyTaskTiming(task: any) {
    for (const step of task.modelSteps) {
      const metadata = step.output.message.metadata;
      if (this.requestStarts.get(metadata?.budgetReceipt?.id) !== metadata?.modelTiming?.requestStartedAt) throw new Error("任务启动时间与历史限流记录不一致");
    }
  }
}
