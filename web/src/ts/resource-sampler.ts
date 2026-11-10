import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log, stamp, errorText } from "./step-log.ts";
export interface Sampling {
  enabled: boolean; strict: boolean; intervalMs?: number; processIntervalMs?: number;
  cgroupDirectory?: string; procDirectory?: string; clockTicks?: number; pageBytes?: number;
  expected: { cpuMax: string; memoryMax: string; swapMax: string };
}
export function parseProc(stat: string, statm: string, clockTicks: number, pageBytes: number) {
  if(!/^\d+ \(.*\) \S /s.test(stat))throw new Error("Invalid proc stat header");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const ppid=Number(fields[1]),ticks=Number(fields[11])+Number(fields[12]),rssPages=Number(statm.trim().split(/\s+/)[1]);
  if (![ppid,ticks,rssPages].every(n=>Number.isSafeInteger(n)&&n>=0)) throw new Error("Invalid proc counters");
  return {ppid,cpuSeconds:ticks/clockTicks,rssBytes:rssPages*pageBytes};
}
export async function resourceSampler(path: string, options: Sampling, workers: () => {id:string;pid:number}[], onFailure:(error:unknown)=>void) {
  const cgroup=options.cgroupDirectory??"/sys/fs/cgroup",proc=options.procDirectory??"/proc";
  let previous:any=null, previousProcesses=new Map<number,number>(), pending=Promise.resolve(), busy=false, stopped=false;
  let nextProcess=0;
  async function sample() {
    const at=stamp();
    if(!options.enabled){log(path,{kind:"unavailable",at,reason:"sampling disabled"});return;}
    const errors:string[]=[];
    async function read(directory:string,name:string) {
      try{return (await readFile(join(directory,name),"utf8")).trim();}catch(e){errors.push(`${name}: ${errorText(e)}`);return null;}
    }
    const [cpu,memory,cpuMax,memoryMax,swapMax]=await Promise.all(["cpu.stat","memory.current","cpu.max","memory.max","memory.swap.max"].map(n=>read(cgroup,n)));
    const usage=cpu===null?null:Number(/usage_usec\s+(\d+)/.exec(cpu)?.[1]);
    const rss=memory===null?null:Number(memory);
    if(usage!==null&&!Number.isFinite(usage))errors.push("Invalid cgroup CPU");
    if(rss!==null&&!Number.isFinite(rss))errors.push("Invalid cgroup memory");
    const quotas={cpuMax,memoryMax,swapMax};
    for(const key of ["cpuMax","memoryMax","swapMax"] as const)if(quotas[key]!==options.expected[key])errors.push(`${key}: expected ${options.expected[key]}, actual ${quotas[key]}`);
    const current={at,cpuUs:Number.isFinite(usage)?usage:null,rssBytes:Number.isFinite(rss)?rss:null};
    log(path,{kind:"cgroup",...current,quotas,available:errors.length===0,errors,
      cpuDeltaUs:previous?.cpuUs!=null&&current.cpuUs!=null?current.cpuUs-previous.cpuUs:null});previous=current;
    if(Date.now()>=nextProcess){
      nextProcess=Date.now()+(options.processIntervalMs??1000);
      const pids=await read(cgroup,"cgroup.procs");
      const rows:any[]=[];
      for(const pid of (pids??"").split(/\s+/).filter(Boolean).map(Number)){
        const reasons:string[]=[];let counters:any=null,command:string|null=null,exitedDuringSample=false;
        try{
          const [stat,statm,cmd]=await Promise.all(["stat","statm","cmdline"].map(n=>readFile(join(proc,String(pid),n),"utf8")));
          counters=parseProc(stat,statm,options.clockTicks??100,options.pageBytes??4096);command=cmd.replaceAll("\0"," ");
        }catch(error){
          const reason=`pid ${pid}: ${errorText(error)}`;reasons.push(reason);
          if(["ENOENT","ESRCH","EACCES","EPERM"].includes((error as NodeJS.ErrnoException).code??"")){
            const currentPids=await read(cgroup,"cgroup.procs");
            exitedDuringSample=currentPids!==null&&!currentPids.split(/\s+/).map(Number).includes(pid);
          }
          if(!exitedDuringSample)errors.push(reason);
        }
        rows.push({pid,...(counters??{ppid:null,cpuSeconds:null,rssBytes:null}),command,reasons,exitedDuringSample});
      }
      const known=new Map(workers().map(w=>[w.pid,w.id]));
      const byPid=new Map(rows.map(r=>[r.pid,r]));
      for(const row of rows){
        let pid=row.pid;const visited=new Set();let owner:string|null=null;
        while(pid&&!visited.has(pid)){visited.add(pid);if(known.has(pid)){owner=known.get(pid)!;break;}pid=byPid.get(pid)?.ppid;}
        row.workerId=owner;row.role=known.has(row.pid)?"worker":row.pid===process.pid||row.pid===1?"main":/python/i.test(row.command??"")?"python":"other";
        row.cpuDeltaSeconds=previousProcesses.has(row.pid)&&row.cpuSeconds!==null?row.cpuSeconds-previousProcesses.get(row.pid)!:null;
      }
      previousProcesses=new Map(rows.filter(r=>r.cpuSeconds!==null).map(r=>[r.pid,r.cpuSeconds]));
      // true = complete; "partial" = some rows failed; false = no usable process data.
      const presentRows=rows.filter(row=>!row.exitedDuringSample);
      const good=presentRows.filter(row=>row.reasons.length===0).length;
      const available=pids===null?false:good===presentRows.length?true:good>0?"partial":false;
      log(path,{kind:"processes",at,available,reason:pids===null?"cgroup.procs unavailable":good<presentRows.length?"process data incomplete":null,rows});
    }
    if(errors.length&&options.strict)throw new Error(errors.join("; "));
  }
  await sample();
  const timer=options.enabled?setInterval(()=>{
    if(busy||stopped)return;busy=true;
    pending=sample().catch(error=>{log(path,{kind:"error",at:stamp(),reason:errorText(error)});if(options.strict)onFailure(error);}).finally(()=>busy=false);
  },options.intervalMs??200):undefined;
  return {async stop(){stopped=true;clearInterval(timer);await pending;await sample().catch(error=>{log(path,{kind:"error",at:stamp(),reason:errorText(error)});if(options.strict)onFailure(error);});}};
}
