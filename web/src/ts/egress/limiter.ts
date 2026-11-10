// 来源：experiments/bfcl_direct/src/ts/limiter.ts；T5：限流与冷却记录增加 configId；策略数字由出口配置传入。
// 所有 Worker 共享的 FIFO 请求入口；启动记录保留在磁盘，跨批次不清零。
import { appendFile, readFile } from "node:fs/promises";
import type { DispatchPolicy } from "./model_config.ts";
export type Clock = { now(): number; monotonicNow?(): number; sleep(ms: number): Promise<void> };
export const realClock: Clock = { now: Date.now, monotonicNow: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export class GlobalLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0;
  private waiters: {grant():void;reject(error:Error):void}[] = [];
  private starts: number[] = [];
  private initialWaitUntil = 0;
  private stopped = false;
  private readonly stopController=new AbortController();
  readonly path: string;
  readonly clock: Clock;
  peak = 0;
  readonly cooldownPath:string;
  constructor(path: string, clock: Clock = realClock, readonly dispatchPolicy?:DispatchPolicy) {
    this.path = path; this.clock = clock;this.cooldownPath=path.replace(/\.jsonl$/,'')+'.cooldowns.jsonl';
  }
  private monotonicNow() { return this.clock.monotonicNow?.() ?? this.clock.now(); }
  private check(){if(this.stopped)throw new Error("请求入口已停止");}
  defer(ms:number){
    if(!Number.isSafeInteger(ms)||ms<0)throw new Error("退避时间无效");
    this.initialWaitUntil=Math.max(this.initialWaitUntil,this.monotonicNow()+ms);
  }
  // T11：429 是服务说太忙，整个出口一起退（global）；其余传输错误只压出错的这个请求（request），
  // 返回它最早可重发的时刻，由 execute 的 notBefore 等待，别的请求照常发。
  async cooldown(ms:number,reservationId:string,reason:"http_429"|"transport"="transport",configId="__global__") {
    if(!Number.isSafeInteger(ms)||ms<0||ms>(this.dispatchPolicy?.maxCooldownMs??900000))
      throw new Error("服务要求的冷却超过本次等待上限；停止且不提前重试");
    const scope=reason==="http_429"?"global":"request",notBefore=this.monotonicNow()+ms;
    if(scope==="global")this.defer(ms);
    if(this.dispatchPolicy){const at=this.clock.now();
      await appendFile(this.cooldownPath,JSON.stringify({configId,reservationId,at,until:at+ms,delayMs:ms,reason,scope})+'\n',{flush:true});}
    return scope==="request"?notBefore:undefined;
  }
  private async waitUntil(deadline: number, signal?: AbortSignal) {
    while (true) {
      signal?.throwIfAborted(); this.check();
      const remaining = deadline - this.monotonicNow();
      if (remaining <= 0) return;
      const ms=Math.max(1,this.dispatchPolicy?Math.min(remaining,1000):remaining);
      let abort!:(error?:unknown)=>void;
      const stopped=new Promise<never>((_,reject)=>{abort=(error)=>reject(error instanceof Event||error===undefined?new Error("请求入口已停止"):error);
        this.stopController.signal.addEventListener('abort',abort,{once:true});if(this.stopped)abort();});
      const cancelled = () => abort(signal?.reason);
      signal?.addEventListener('abort', cancelled, {once: true});
      if (signal?.aborted) cancelled();
      try{await Promise.race([this.clock.sleep(ms),stopped]);}
      finally{this.stopController.signal.removeEventListener('abort',abort);signal?.removeEventListener('abort',cancelled);}
    }
  }
  private async waitForPermit(signal?: AbortSignal) {
    for(;;){
      signal?.throwIfAborted(); this.check();
      const now = this.monotonicNow(), last = this.starts.at(-1), windowStart = this.starts.at(-(this.dispatchPolicy?.requestsPerMinute??60));
      const allowed=Math.max(now,this.initialWaitUntil,last===undefined?now:last+(this.dispatchPolicy?.minIntervalMs??1000),
        windowStart===undefined?now:windowStart+60000);
      if(allowed<=now)return;
      await this.waitUntil(allowed, signal);
      // 其他在途请求可能延长全局冷却，醒来后重新计算发送许可。
    }
  }
  async load() {
    let text = "";
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (text && !text.endsWith("\n")) throw new Error("限流记录不完整");
    const history = text.split("\n").filter(Boolean).map(line => {
      const event = JSON.parse(line);
      if (!Number.isSafeInteger(event.at) || event.at < 0 || typeof event.id !== "string" || !event.id) throw new Error("限流记录无效");
      return event;
    });
    if (new Set(history.map(event => event.id)).size !== history.length) throw new Error("限流请求ID重复");
    const rpm=this.dispatchPolicy?.requestsPerMinute??60,interval=this.dispatchPolicy?.minIntervalMs??1000;
    const wall = this.clock.now(), mono = this.monotonicNow(), tail = history.slice(-rpm);
    let shortIntervals = 0, backwardIntervals = 0, fastWindows = 0, recentAnomaly = false;
    for (let i = 1; i < history.length; i++) {
      const gap = history[i].at - history[i-1].at;
      if (gap >= 0 && gap < interval) shortIntervals++;
      if (gap < 0) { backwardIntervals++; recentAnomaly ||= i >= history.length - rpm && Math.max(history[i].at, history[i-1].at) >= wall - 60000; }
      if (i >= rpm && history[i].at - history[i-rpm].at < 60000) {
        fastWindows++; recentAnomaly ||= i >= history.length - rpm && Math.max(history[i].at, history[i-rpm].at) >= wall - 60000;
      }
    }
    const futureTimestamps = tail.filter(event => event.at > wall).length;
    recentAnomaly ||= futureTimestamps > 0;
    if (shortIntervals || backwardIntervals || fastWindows || futureTimestamps) console.warn(JSON.stringify({kind:"rate_history_warning",
      shortIntervals,backwardIntervals,fastWindows,futureTimestamps,cooldownMs:recentAnomaly ? 60000 : 0}));
    this.starts = [];
    this.initialWaitUntil = history.length ? mono + interval : 0;
    if (recentAnomaly) {
      // 无法据异常墙钟还原旧请求节奏；在测量/Worker启动前保守冷却一整分钟。
      await this.waitUntil(mono + 60000);
      this.initialWaitUntil = 0;
    } else {
      // 仅映射仍在一分钟内的历史；过期旧记录不引入一分钟固定等待。
      this.starts = tail.filter(event => wall - event.at < 60000).map(event => mono - (wall - event.at));
    }
    if(this.dispatchPolicy){
      let cooldownText='';try{cooldownText=await readFile(this.cooldownPath,'utf8');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(cooldownText&&!cooldownText.endsWith('\n'))throw new Error('冷却记录不完整');
      let until=0;
      for(const line of cooldownText.split('\n').filter(Boolean)){
        const event=JSON.parse(line);
        if(!['http_429','transport'].includes(event.reason)||typeof event.reservationId!=='string'||!event.reservationId
            ||![event.at,event.until,event.delayMs].every(value=>Number.isSafeInteger(value)&&value>=0)
            ||event.until!==event.at+event.delayMs||![undefined,'global','request'].includes(event.scope))throw new Error('冷却记录无效');
        // T11：只恢复全局冷却；只压单个请求的那种随原请求结束。没有 scope 的旧记录当时都是全局的。
        if(event.scope!=='request')until=Math.max(until,event.until);
      }
      const remaining=Math.max(0,until-this.clock.now());
      if(remaining>this.dispatchPolicy.maxCooldownMs)throw new Error('历史冷却或时钟偏差超过本次等待上限');
      this.defer(remaining);
    }
  }
  stop() {this.stopped=true;this.stopController.abort();for(const waiter of this.waiters.splice(0))waiter.reject(new Error('请求入口已停止'));}
  async execute<T>(reserve: () => Promise<string>, action: (id: string, waitMs: number, at: number) => Promise<T>, configId="__global__", notBefore?:number, signal?: AbortSignal) {
    const queuedAt = this.monotonicNow();
    signal?.throwIfAborted(); this.check();
    // T11：只压这个请求的冷却；等待时不占在途名额、不挡串行准入，计入它自己的 waitMs。
    if (notBefore !== undefined) await this.waitUntil(notBefore, signal);
    signal?.throwIfAborted();
    if (this.active >= (this.dispatchPolicy?.maxInFlight??4)) await new Promise<void>((resolve,reject) => {
      const clear = () => signal?.removeEventListener('abort', cancel);
      const waiter = {grant: () => {clear(); resolve();}, reject: (error: Error) => {clear(); reject(error);}};
      const cancel = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(signal!.reason);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', cancel, {once: true});
    });
    else this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      const admission = this.tail.then(async () => {
        signal?.throwIfAborted();
        if (this.stopped) throw new Error("请求入口已停止");
        await this.waitForPermit(signal);
        if (this.stopped) throw new Error("请求入口已停止");
        const id = await reserve();
        if (!signal) await this.waitForPermit();
        const at = this.clock.now();
        if (!Number.isSafeInteger(at) || at < 0) throw new Error("请求登记时间无效");
        await appendFile(this.path, JSON.stringify({ configId, id, at }) + "\n", { flush: true });
        await this.waitForPermit(signal);
        if (this.stopped) throw new Error("请求入口已停止");
        // 以刷盘完成后的实际发送时刻计限流，网络执行不占用串行准入队列。
        const sentAt = this.monotonicNow();
        this.starts.push(sentAt); if (this.starts.length > (this.dispatchPolicy?.requestsPerMinute??60)) this.starts.shift();
        const result = Promise.resolve(action(id, sentAt - queuedAt, at));
        void result.catch(() => {});
        return { result };
      });
      this.tail = admission.catch(() => undefined);
      const { result } = await admission;
      // 预留/刷盘期间其他请求也可能失败；已预留金额由调用方保留，不再发出新请求。
      return await result;
    } finally {
      const next = this.waiters.shift();
      if (next) next.grant(); else this.active--;
    }
  }
}
