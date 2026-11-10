import {cpus,totalmem,freemem,platform} from 'node:os';
import {execFile} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {log,now,env,maybe} from './io.ts';
import {docker} from '../docker/common.ts';
// T9 C1 #33: Docker VM memory, read-only. `docker info` gives the VM's total memory and `docker stats --no-stream`
// the memory of every running container; nothing is started. The VM's own free memory (/proc/meminfo inside the VM)
// is not reachable without starting a container, so approxAvailableBytes = total - sum(container memory) is an upper bound.
// Only runs for container plans, at most every 5 s, never overlapping; a failed sample is recorded as unavailable.
const scales:Record<string,number>={B:1,kB:1e3,KB:1e3,MB:1e6,GB:1e9,KiB:1024,MiB:1024**2,GiB:1024**3,TiB:1024**4};
export function memUsageBytes(text:string){const m=/^([\d.]+)\s*(B|kB|KB|MB|GB|KiB|MiB|GiB|TiB)\s*\//.exec(String(text));return m?Number(m[1])*scales[m[2]]:null;}
export function dockerVmSampler(path:string,interval:number){
  let total:number|null=null,busy:Promise<void>|undefined;
  const sample=async()=>{const at=now();try{
    if(total===null){const r=await docker(['info','--format','{{json .MemTotal}}'],true);const v=Number(r.stdout.trim());if(r.code===0&&Number.isFinite(v)&&v>0)total=v;}
    const r=await docker(['stats','--no-stream','--format','{{json .}}'],true);if(r.code!==0)throw new Error('docker stats exit '+r.code+': '+String(r.stderr).slice(0,300));
    const rows=String(r.stdout).split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s)),used=rows.map(x=>memUsageBytes(x.MemUsage));
    const known=used.every(v=>v!==null),sum=known?used.reduce((a,b)=>a+b!,0):null;
    log(path,{at,available:known&&total!==null,memTotalBytes:total,containerMemUsedBytes:sum,containers:rows.length,approxAvailableBytes:total!==null&&sum!==null?total-sum:null,...(known?{}:{error:'unparsed MemUsage'})});
  }catch(e){log(path,{at,available:false,memTotalBytes:total,containerMemUsedBytes:null,containers:null,approxAvailableBytes:null,error:String(e).slice(0,500)});}};
  const tick=()=>{if(!busy)busy=sample().finally(()=>busy=undefined);};
  tick();const timer=setInterval(tick,Math.max(5000,interval));timer.unref();
  return {async stop(){clearInterval(timer);await busy;}};
}
export async function hostSampler(path:string,interval:number,report:string){
  let previous=cpus(),pending=Promise.resolve(),busy=false;
  const sample=async()=>{const current=cpus();const total=(a:typeof current)=>a.reduce((s,c)=>s+Object.values(c.times).reduce((a,b)=>a+b,0),0);const dt=total(current)-total(previous),idle=current.reduce((s,c)=>s+c.times.idle,0)-previous.reduce((s,c)=>s+c.times.idle,0);previous=current;
    let processCount:number|null=null,processError:string|null=null;
    try{processCount=platform()==='win32'?await new Promise<number>((yes,no)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-Process).Count'],{windowsHide:true,timeout:10000,env:env(report)},(e,out)=>e?no(e):yes(Number(out.trim())))):readdirSync('/proc').filter(n=>/^\d+$/.test(n)).length;}catch(e){processError=String(e);}
    log(path,{at:now(),cpuPercent:dt>0?100*(1-idle/dt):null,usedMemoryBytes:totalmem()-freemem(),totalMemoryBytes:totalmem(),processCount,processError});
  };await sample();const timer=setInterval(()=>{if(busy)return;busy=true;pending=sample().finally(()=>busy=false);},interval);
  let vm:{stop():Promise<void>}|undefined;try{if(maybe(join(dirname(dirname(path)),'plan.json'))?.stage?.launcher?.kind==='docker')vm=dockerVmSampler(join(dirname(path),'docker-vm.jsonl'),interval);}catch{}
  return {async stop(){clearInterval(timer);await pending;await sample();await vm?.stop();}};
}
