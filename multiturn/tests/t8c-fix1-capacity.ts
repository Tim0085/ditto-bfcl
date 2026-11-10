import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdirSync,writeFileSync,openSync,closeSync,existsSync,statSync} from 'node:fs';
import {cpus,freemem,totalmem} from 'node:os';
import assert from 'node:assert/strict';
import {docker,labels,inspect,assertOwned} from '../src/ts/docker/common.ts';
import {json,sleep,env,read,lines} from '../src/ts/scheduler/io.ts';
const root=resolve(process.argv[2]),split=resolve(process.argv[3]),tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev',matrixScript=process.argv.find(a=>a.startsWith('--matrix='))?.slice(9)??'tests/t8c-matrix.ts';mkdirSync(root,{recursive:true});
const image=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0];
const runId='t8cf1-memory-'+process.pid,unitId='memory-probe';
const python="import json,time\nfrom pathlib import Path\nwhile True:\n d={s.split(':')[0]:int(s.split()[1])*1024 for s in Path('/proc/meminfo').read_text().splitlines() if s.startswith(('MemTotal:','MemAvailable:'))}\n print(json.dumps(dict(at=time.time(),**d)),flush=True)\n time.sleep(1)";
const create=['create','--pull=never','--network','none','--init','--name','sec1-'+runId,...labels(runId,unitId),'--memory=32m','--memory-swap=32m','--cpus=.1','--pids-limit=16','--cap-drop=ALL','--security-opt','no-new-privileges',image.Id,'python3','-B','-u','-c',python];
const stopFile=join(root,'capacity.stop'),watchFd=openSync(join(root,'host-monitor.log'),'wx');
const watch=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File','tests/t8c-fix1-host.ps1','-Output',join(root,'host-capacity.jsonl'),'-StopFile',stopFile,'-ParentPid',String(process.pid)],{windowsHide:true,env:env(join(root,'guards/host-capacity')),stdio:['ignore',watchFd,watchFd]});closeSync(watchFd);const watchDone=new Promise<{code:number|null;error?:string}>(yes=>{watch.once('error',error=>yes({code:null,error:String(error)}));watch.once('close',code=>yes({code}));});
let id:string|undefined,workload:{start:number;end?:number}|undefined;const failures:unknown[]=[];
try{
  const readyEnd=Date.now()+30000,hostPath=join(root,'host-capacity.jsonl');
  while(!existsSync(hostPath)||statSync(hostPath).size===0){if(Date.now()>readyEnd)throw Error('Read-only host observer did not publish its first sample within 30000ms');await sleep(25);}
  id=(await docker(create)).stdout.trim();json(join(root,'vm-monitor-command.json'),['docker',...create]);await docker(['start',id]);
  const before=cpus();await sleep(250);const after=cpus(),dt=after.reduce((n,c,i)=>n+Object.values(c.times).reduce((a,b)=>a+b,0)-Object.values(before[i].times).reduce((a,b)=>a+b,0),0),idle=after.reduce((n,c,i)=>n+c.times.idle-before[i].times.idle,0);
  json(join(root,'baseline.json'),{at:new Date().toISOString(),cpuPercent:dt?100*(1-idle/dt):null,availableMemoryBytes:freemem(),totalMemoryBytes:totalmem(),imageId:image.Id,monitorContainer:id,monitorMemoryLimitBytes:32*1024**2,warning:'One additional measurement-only container; never counted among the 18 workload configurations; its small overhead is included in VM available memory.'});
  const command=['--import','./scripts/egress-offline-guard.mjs','--experimental-transform-types',matrixScript,root,split,'--tag='+tag];
  workload={start:Date.now()};
  const child=spawn(process.execPath,command,{windowsHide:true,env:{...env(join(root,'guards/capacity')),...(process.env.T8A_REFERENCE_ROOT?{T8A_REFERENCE_ROOT:process.env.T8A_REFERENCE_ROOT}:{})},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});workload.end=Date.now();writeFileSync(join(root,'matrix-command.log'),'COMMAND: node '+command.join(' ')+'\n'+stdout+'\n'+stderr+'\nEXIT_CODE='+code+'\n');assert.equal(code,0,stdout+stderr);
}catch(error){failures.push(error);}finally{
  try{writeFileSync(stopFile,'stop');}catch(error){failures.push(error);}
  const finishWatch=async()=>{
    const bounded=async(ms:number)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([watchDone,new Promise<null>(yes=>{timer=setTimeout(()=>yes(null),ms);})]);}finally{clearTimeout(timer);}};
    let result=await bounded(10000);
    if(result===null){failures.push(Error('Own host measurement helper did not exit within 10000ms'));watch.kill();result=await bounded(5000);}
    return result??{code:null,error:'Own host measurement helper did not confirm exit after kill request'};
  };
  // Joining or publishing evidence for the host observer cannot skip VM cleanup.
  const joining=finishWatch().catch(error=>{failures.push(error);return {code:null,error:String(error)};});
  try{
    if(id){const info=await inspect(id);assertOwned(info,runId,unitId);if(info.State.Running)await docker(['kill','--signal=SIGTERM',info.Id]);await docker(['wait',info.Id]);const terminal=await inspect(info.Id);assertOwned(terminal,runId,unitId);assert.equal(terminal.State.Running,false);assert.equal(terminal.State.OOMKilled,false);
      try{const logs=await docker(['logs',info.Id]);writeFileSync(join(root,'vm-memory.jsonl'),logs.stdout);writeFileSync(join(root,'vm-memory-stderr.log'),logs.stderr);
        const samples=logs.stdout.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));assert(samples.length>1,'VM monitor must span the workload');const firstAt=samples[0].at*1000,lastAt=samples.at(-1).at*1000;if(workload?.end){assert(firstAt<=workload.start+2000,'VM monitor started too late');assert(lastAt>=workload.end-2000,'VM monitor ended before the workload');}json(join(root,'vm-capacity.json'),{imageId:image.Id,totalMemoryBytes:samples[0].MemTotal,minimumAvailableMemoryBytes:Math.min(...samples.map(r=>r.MemAvailable)),samples:samples.length,firstAt,lastAt,workload,maximumGapMs:Math.max(...samples.slice(1).map((r,i)=>(r.at-samples[i].at)*1000)),measurementContainerId:info.Id,measurementMemoryLimitBytes:32*1024**2,observerExitCode:terminal.State.ExitCode,observerOomKilled:terminal.State.OOMKilled});
      }finally{await docker(['rm',info.Id]);}
    }
  }catch(error){failures.push(error);}
  const watchResult=await joining;
  try{json(join(root,'host-monitor-exit.json'),{...watchResult,pid:watch.pid});}catch(error){failures.push(error);}
  try{
    assert.equal(watchResult.error,undefined,'read-only host monitor could not start');assert.equal(watchResult.code,0,'read-only host monitor must finish successfully');
    const samples=lines(join(root,'host-capacity.jsonl'));assert(samples.length>1);const minimum=Math.min(...samples.map(s=>s.availableMemoryBytes));
    const firstAt=Date.parse(samples[0].at),lastAt=Date.parse(samples.at(-1).at);if(workload?.end){assert(firstAt<=workload.start+3000,'Host observer started too late');assert(lastAt>=workload.end-2000,'Host observer ended before the workload');}
    json(join(root,'host-capacity.json'),{imageId:image.Id,samples:samples.length,minimumAvailableMemoryBytes:minimum,peakPagefileInUseBytes:Math.max(...samples.map(s=>s.pagefileInUseBytes)),baselinePagefileInUseBytes:samples[0].pagefileInUseBytes,below500MiBSamples:samples.filter(s=>s.below500MiB).length,thresholdAction:'record only; never pause, alter quotas or system settings',peakCpuPercent:Math.max(...samples.map(s=>s.cpuPercent??0)),firstAt,lastAt,workload,maximumGapMs:Math.max(...samples.slice(1).map((r,i)=>Date.parse(r.at)-Date.parse(samples[i].at))),vm:read(join(root,'vm-capacity.json'))});
  }catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Capacity measurement/cleanup failed');
}
