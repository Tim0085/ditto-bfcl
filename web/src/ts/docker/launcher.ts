import { createHash,randomUUID } from "node:crypto";
import { MODEL_ENDPOINT_PATH } from "../model-endpoint.ts";
import { writeFile, appendFile, mkdir, readdir, copyFile,realpath } from "node:fs/promises";
import { join,resolve,relative,isAbsolute } from "node:path";
import type { RunUnitLauncher,RunUnit,RunUnitSpec,RunUnitExit } from "../run-unit.ts";
import { SEC1_IMAGE_REPOSITORY,SEC1_LABELS,SEC1_OWNER } from "../run-unit.ts";
import { docker,json,save,publish,identifier,directory,labels,inspect,assertOwned,removeExited,ownerFilter,renameWithRetry,mountPath } from "./common.ts";
import {verifyWorktreeImage} from './image-context.ts';
import {ROOT,log,now} from '../scheduler/io.ts';
import { auxiliarySample } from './sampling.ts';
import { acquireCollector } from './collector-lock.ts';
export const PIDS_LIMIT=1024; // Acceptance measures Uniform32/c8; see delivery evidence before production use.
export function containerName(runId:string,unitId:string){identifier(runId);identifier(unitId);return `sec1-${runId.slice(0,45)}-${unitId.slice(0,45)}-${createHash('sha256').update(JSON.stringify([runId,unitId])).digest('hex').slice(0,16)}`;}
export function egressPort(url:string){const u=new URL(url);if(u.protocol!=="http:"||u.hostname!=="127.0.0.1"||u.username||u.password||!["/",MODEL_ENDPOINT_PATH].includes(u.pathname)||u.search||u.hash||!u.port)throw Error("Egress must be http://127.0.0.1:<port>[/v1/sample]");return Number(u.port);}
function completeExit(value:any):value is RunUnitExit {
  const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&!v.startsWith('0001-');
  return value!==null&&typeof value==='object'&&!Array.isArray(value)
    &&(value.exitCode===null||Number.isSafeInteger(value.exitCode))
    &&(value.signal===null||typeof value.signal==='string')
    &&typeof value.killed==='boolean'&&typeof value.stoppedByPlan==='boolean'
    &&(value.oomKilled===null||typeof value.oomKilled==='boolean')
    &&(date(value.startedAt)&&date(value.endedAt)||value.collection?.neverStarted===true
      &&value.exitCode===null&&value.startedAt===null&&value.endedAt===null)
    &&Object.hasOwn(value,'summary');
}
export class DockerLauncher implements RunUnitLauncher {
  readonly kind="docker" as const;
  private handles=new Map<string,RunUnit>();
  constructor(readonly imageId:string,readonly runtime:{clockTicks:number;pageBytes:number},readonly tag="dev",readonly root?:string) {
    if(!/^sha256:[a-f0-9]{64}$/.test(imageId)||! /^(dev|\d+\.\d+\.\d+|exp\d+-v\d+|test-[a-z0-9-]+)$/.test(tag))throw Error("Invalid image identity/tag");
    if(!Object.values(runtime).every(n=>Number.isSafeInteger(n)&&n>0))throw Error("Measured getconf values required");
  }
  async verifyImage(){const info=JSON.parse((await docker(["image","inspect",`${SEC1_IMAGE_REPOSITORY}:${this.tag}`])).stdout)[0];if(info.Id!==this.imageId||info.Config.Labels?.[SEC1_LABELS.owner]!==SEC1_OWNER||info.Config.Labels?.['sec1.complete']!=='true')throw Error("Image tag changed or owner/complete mismatch; regenerate plan explicitly");await verifyWorktreeImage(ROOT,info,this.tag);}
  toUnitView(spec:RunUnitSpec){
    egressPort(spec.egressUrl);identifier(spec.runId);identifier(spec.unitId);
    const b=structuredClone(spec.block);if(b.runId!==spec.runId)throw Error("Block runId mismatch");identifier(String(b.configId));
    return {...b,python:"/usr/local/bin/python3",outputRoot:"/output",modelEndpoint:`http://127.0.0.1:18080${MODEL_ENDPOINT_PATH}`,
      sampling:{...(b.sampling as object),cgroupDirectory:"/sys/fs/cgroup",procDirectory:"/proc",...this.runtime}};
  }
  async start(spec:RunUnitSpec){
    await this.verifyImage();const view=this.toUnitView(spec);
    for(const p of [spec.outputRoot,spec.logDir,spec.guardReportDir]){mountPath(p);await directory(p);}
    await publish(join(spec.logDir,"unit.json"),JSON.stringify({spec,imageId:this.imageId,runtime:this.runtime,tag:this.tag},null,2),true);
    await publish(join(spec.logDir,"block.json"),JSON.stringify(view,null,2),true);
    const args=["create","--pull=never","--name",containerName(spec.runId,spec.unitId),...labels(spec.runId,spec.unitId),"--label",`sec1.log-dir=${spec.logDir}`,
      "--init","--cpus=2","--memory=4g","--memory-swap=4g",`--pids-limit=${PIDS_LIMIT}`,"--cap-drop=ALL","--security-opt","no-new-privileges","--restart=no",
      ...[[spec.outputRoot,"/output"],[spec.logDir,"/unit"],[spec.guardReportDir,"/guard"]].flatMap(([source,target])=>["--mount",`type=bind,source=${source},target=${target}`]),
      this.imageId,"python3","-B","/app/scripts/docker-entry.py","--target",`host.docker.internal:${egressPort(spec.egressUrl)}`];
    await save(join(spec.logDir,"create-command.json"),["docker",...args]);
    const id=(await docker(args)).stdout.trim();
    try {await docker(["start",id]);}catch(error){await removeExited(id,spec.runId,spec.unitId);throw error;}
    return this.handle(id,spec);
  }
  async list(runId:string){identifier(runId);const ids=(await docker(["ps","-aq",...ownerFilter,"--filter",`label=${SEC1_LABELS.run}=${runId}`])).stdout.trim().split(/\s+/).filter(Boolean);const units:string[]=[];for(const id of ids){const info=await inspect(id);assertOwned(info,runId);units.push(info.Config.Labels[SEC1_LABELS.unit]);}return units;}
  async adopt(runId:string,unitId:string){identifier(runId);identifier(unitId);const ids=(await docker(["ps","-aq",...ownerFilter,"--filter",`label=${SEC1_LABELS.run}=${runId}`,"--filter",`label=${SEC1_LABELS.unit}=${unitId}`])).stdout.trim().split(/\s+/).filter(Boolean);const matches=[];
    const inside=(base:string,path:string)=>{const rel=relative(base,path);return rel!==''&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel);};
    const physicalRoot=this.root?await realpath(resolve(this.root)):undefined;
    const own=async(path:string)=>!this.root||inside(resolve(this.root),resolve(path))&&inside(physicalRoot!,await realpath(path));
    for(const id of ids){const info=await inspect(id);assertOwned(info,runId,unitId);const dir=info.Config.Labels['sec1.log-dir'];
      if(typeof dir!=='string')throw Error('Missing unit log directory');
      if(!await own(dir)){log(join(this.root!,'scheduler/events.jsonl'),{at:now(),kind:'foreign-root-unit-ignored',unitId,containerId:info.Id,logDir:dir,physicalRoot,reason:'log directory is outside this run root lexically or after realpath'});continue;}
      const saved=await json(join(dir,'unit.json'));
      if(saved.spec.logDir!==dir||!await own(saved.spec.logDir))throw Error('Persisted unit log directory mismatch');
      if(saved.spec.runId!==runId||saved.spec.unitId!==unitId||saved.imageId!==info.Image)throw Error('Persisted unit mismatch');
      if(info.Image!==this.imageId)throw Error('Adopt image does not match plan');matches.push({info,spec:saved.spec});
    }
    if(matches.length>1)throw Error('Duplicate unit labels');if(!matches.length)return undefined;return this.handle(matches[0].info.Id,matches[0].spec);
  }
  private async handle(reference:string,spec:RunUnitSpec):Promise<RunUnit> {
    const initial=await inspect(reference);assertOwned(initial,spec.runId,spec.unitId);
    const id:string=initial.Id;
    const existing=this.handles.get(id);if(existing)return existing;
    let waiting:Promise<RunUnitExit>|undefined;
    let collected=false;
    const pendingIntents=new Set<Promise<void>>();
    const inFlightIntents=new Map<string,Promise<void>>();
    // These files record method requests, not proof of signal delivery or termination.
    const sendIntent=async(kind:"stop"|"kill",reason:string)=>{
      if(collected)return;
      const info=await inspect(id);assertOwned(info,spec.runId,spec.unitId,id);
      if(!info.State.Running)return;
      const path=join(spec.logDir,kind+".json");
      const request={reason,at:new Date().toISOString(),containerId:id,requestId:randomUUID()};
      const history=join(spec.logDir,kind+"-requests");await mkdir(history,{recursive:true});
      const record=async(result:object)=>{
        const value={...request,...result};
        // Per-request records are authoritative across handles/processes. The familiar
        // kill.json/stop.json files remain a latest-request view for operators.
        const temporary=join(history,request.requestId+".tmp");
        await save(temporary,value);await renameWithRetry(temporary,join(history,request.requestId+".json"));await save(path,value);
      };
      await record({status:"requested"});
      try {
        // Write-ahead boundary: a crash after this point cannot prove delivery or success.
        if(kind==="kill")await record({status:"dispatched",dispatchedAt:new Date().toISOString()});
        // Send only SIGTERM and return its delivery receipt. Waiting belongs to wait();
        // an indefinitely waiting `docker stop` process would outlive a paused scheduler.
        await docker(kind==="stop"?["kill","--signal=SIGTERM",id]:["kill",id]);
      }catch(error){
        if(/is not running|No such (object|container)/i.test(String(error))){
          await record({status:/No such (object|container)/i.test(String(error))?'not-found':'not-running',
            completedAt:new Date().toISOString(),killed:false,error:String(error)});
          return;
        }
        await record({status:"failed",completedAt:new Date().toISOString(),error:String(error)});
        throw error;
      }
      await record({status:"succeeded",completedAt:new Date().toISOString()});
    };
    const intent=(kind:"stop"|"kill",reason:string)=>{
      if(collected)return Promise.resolve();
      // Coalesce concurrent duplicate calls so a second failure cannot overwrite success.
      const existing=inFlightIntents.get(kind);if(existing)return existing;
      const operation=sendIntent(kind,reason);pendingIntents.add(operation);
      inFlightIntents.set(kind,operation);
      const settled=()=>{pendingIntents.delete(operation);inFlightIntents.delete(kind);};
      operation.then(settled,settled);
      return operation;
    };
    const collectWork=async()=>{
      const exitPath=join(spec.logDir,'exit.json');
      let saved:RunUnitExit|undefined;
      try{const value=await json(exitPath);if(!completeExit(value))throw new SyntaxError('Incomplete or invalid exit record fields');saved=value;}catch(error:any){
        if(error instanceof SyntaxError){
          const damaged=exitPath+'.damaged-'+Date.now()+'-'+randomUUID();
          await renameWithRetry(exitPath,damaged);
          await save(damaged+'.recovery.json',{at:new Date().toISOString(),containerId:id,source:exitPath,preserved:damaged,error:String(error)});
        }else if(error.code!=='ENOENT')throw error;
      }
      if(saved){
        const state=await docker(['inspect',id],true);
        if(state.code===0)await removeExited(id,spec.runId,spec.unitId);
        else if(!/No such (object|container)/i.test(state.stderr))throw Error(state.stderr);
        return saved;
      }
      const presence=await docker(['inspect',id],true);
      if(presence.code!==0){
        if(/No such (object|container)/i.test(presence.stderr))throw Error('Missing complete exit record '+exitPath+' and container '+id+' is absent; see docs/T8b_容器恢复手册.md: 退出记录损坏。不能补造退出记录。');
        throw Error(presence.stderr);
      }
      const present=JSON.parse(presence.stdout)[0];assertOwned(present,spec.runId,spec.unitId,id);
      const neverStarted=present.State.Status==='created'||/^0001-/.test(present.State.StartedAt);
      let busy:Promise<void>|undefined;
      const sample=()=>{if(!busy)busy=auxiliarySample(async()=>{const r=await docker(["stats","--no-stream","--format","{{json .}}",id],true);await appendFile(join(spec.logDir,"docker-stats.jsonl"),JSON.stringify({at:new Date().toISOString(),available:r.code===0,...r})+"\n");},async error=>{await appendFile(join(spec.logDir,'docker-stats-errors.jsonl'),JSON.stringify({at:new Date().toISOString(),available:false,error:String(error)})+'\n');}).finally(()=>busy=undefined);};
      if(!neverStarted){
        sample();const timer=setInterval(sample,2000);timer.unref();
        try{await docker(["wait",id]);}finally{clearInterval(timer);await busy;}
      }
      const info=await inspect(id);assertOwned(info,spec.runId,spec.unitId,id);
      await Promise.allSettled([...pendingIntents]);
      const logs=await docker(["logs","--timestamps",id]);await writeFile(join(spec.logDir,"stdout.log"),logs.stdout);await writeFile(join(spec.logDir,"stderr.log"),logs.stderr);
      await save(join(spec.logDir,"inspect.json"),info);
      const requests=async(kind:string)=>{
        let names:string[]=[];const history=join(spec.logDir,kind+"-requests");
        try{names=(await readdir(history)).filter(n=>n.endsWith('.json'));}catch(e:any){if(e.code!=="ENOENT")throw e;}
        if(names.length)return Promise.all(names.map(n=>json(join(history,n))));
        try{return [await json(join(spec.logDir,kind+".json"))];}catch(e:any){if(e.code!=="ENOENT")throw e;return [];}
      };
      let summary=null,summaryError:string|null=null;
      const summaryPath=join(spec.outputRoot,"configs",String(spec.block.configId),"block-summary.json");
      try{summary=await json(summaryPath);}catch(e:any){
        if(e instanceof SyntaxError){
          const damaged=summaryPath+'.damaged-'+Date.now()+'-'+randomUUID();
          await copyFile(summaryPath,damaged);
          summaryError=String(e);
          await save(damaged+'.recovery.json',{at:new Date().toISOString(),source:summaryPath,preserved:damaged,containerId:id,error:summaryError});
        }else if(e.code!=="ENOENT")throw e;
      }
      const killRequests=await requests("kill");
      const relevant=killRequests.filter(r=>r.containerId===undefined||r.containerId===id);
      const sigkillExit=info.State.ExitCode===137&&!info.State.OOMKilled;
      const killed=relevant.some(r=>r.status==="succeeded")&&sigkillExit;
      const uncertain=relevant.some(r=>r.status==="dispatched"||!["requested","succeeded","failed","not-running","not-found"].includes(r.status));
      const outcome=killed?"confirmed":sigkillExit&&uncertain?"unconfirmed":relevant.length&&relevant.every(r=>r.status==="requested")?"not-dispatched":relevant.length?"not-confirmed":"not-requested";
      // Persist before exit.json; consumers must read this record as well as the boolean.
      await save(join(spec.logDir,"kill-outcome.json"),{
        containerId:id,outcome,killed,exitCode:neverStarted?null:info.State.ExitCode,oomKilled:info.State.OOMKilled,
        explanation:outcome==="unconfirmed"?"已发出、未确认（旧格式记录同样无法确认）；不能判定由本启动器强杀":
          outcome==="not-dispatched"?"请求已记录、命令未发出":outcome==="confirmed"?"命令明确成功返回，退出137且非OOM":"没有足够证据确认强杀",
        requests:relevant,at:new Date().toISOString()
      });
      // Interface: stop() was received before exit, not necessarily the cause of exit.
      const stoppedByPlan=(await requests("stop")).some(r=>r.containerId===undefined||r.containerId===id);
      // The read-only interface types dates as string, but explicitly requires null
      // for unavailable fields. Keep that runtime contract without editing it.
      const result={exitCode:neverStarted?null:info.State.ExitCode,signal:killed?"SIGKILL":null,killed,stoppedByPlan,oomKilled:info.State.OOMKilled,
        startedAt:neverStarted?null:info.State.StartedAt,endedAt:neverStarted?null:info.State.FinishedAt,summary,
        collection:{neverStarted,explanation:neverStarted?'没启动过':null,summaryError}} as RunUnitExit;
      await save(join(spec.logDir,"exit.json"),result);await removeExited(id,spec.runId,spec.unitId);return result;
    };
    const collect=async()=>{
      const release=await acquireCollector(spec.logDir,id);
      try{return await collectWork();}finally{await release();}
    };
    const handle:RunUnit={unitId:spec.unitId,wait:()=>waiting??=collect().then(result=>{collected=true;return result;},error=>{waiting=undefined;throw error;}),stop:reason=>intent("stop",reason),kill:reason=>intent("kill",reason),isAlive:async()=>{if(collected)return false;const r=await docker(["inspect",id],true);if(r.code!==0){if(/No such (object|container)/i.test(r.stderr))return false;throw Error(r.stderr);}const info=JSON.parse(r.stdout)[0];assertOwned(info,spec.runId,spec.unitId,id);return info.State.Running;}};
    this.handles.set(id,handle);return handle;
  }
}
