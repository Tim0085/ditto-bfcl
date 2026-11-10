import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, realpath, rename, link, unlink } from "node:fs/promises";
import {existsSync,realpathSync} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve, parse,dirname,basename } from "node:path";
import { SEC1_LABELS, SEC1_OWNER } from "../run-unit.ts";
// Control/observation commands must not block orchestration indefinitely. Bulk local
// copies/commits get two minutes; wait intentionally follows the container lifetime.
export function dockerTimeoutMs(args:string[]){return args[0]==='wait'?0:['cp','commit'].includes(args[0])?120000:15000;}
export class DockerTimeoutError extends Error {
  constructor(readonly args:string[],readonly timeoutMs:number){super(`docker ${args.join(' ')} timed out after ${timeoutMs}ms; container state is unknown`);}
}
export async function docker(args:string[], allowFailure=false, env:NodeJS.ProcessEnv=process.env) {
  const child=spawn("docker",args,{windowsHide:true,stdio:["ignore","pipe","pipe"],env});
  let stdout="",stderr="";
  child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
  const timeoutMs=dockerTimeoutMs(args);
  const code=await new Promise<number|null>((yes,no)=>{
    let settled=false;
    const finish=(error:unknown,code:number|null=null)=>{if(settled)return;settled=true;clearTimeout(timer);error?no(error):yes(code);};
    const timer=timeoutMs?setTimeout(()=>{child.kill();child.stdout.destroy();child.stderr.destroy();finish(new DockerTimeoutError(args,timeoutMs));},timeoutMs):undefined;
    child.once('error',error=>finish(error));child.once('close',code=>finish(null,code));
  });
  if(code!==0&&!allowFailure)throw new Error(`docker ${args[0]}: ${code}\n${stderr}\n${stdout}`);
  return {code,stdout,stderr};
}
export const json=async(path:string)=>JSON.parse(await readFile(path,"utf8"));
export async function renameWithRetry(from:string,to:string){
  for(let attempt=0;;attempt++){try{await rename(from,to);return;}catch(error:any){
    if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt===100)throw error;
    await new Promise(resolve=>setTimeout(resolve,5));
  }}
}
// Publish only complete bytes; pending names are never interpreted as records.
export async function publish(path:string,data:string,exclusive=false){
  const temp=path+'.pending-'+randomUUID();
  try{await writeFile(temp,data,{flag:'wx'});
    if(exclusive)await link(temp,path);
    else await renameWithRetry(temp,path);
  }finally{try{await unlink(temp);}catch(error:any){if(error.code!=='ENOENT')throw error;}}
}
export const save=(path:string,value:unknown,exclusive=false)=>publish(path,JSON.stringify(value,null,2)+"\n",exclusive);
export function identifier(value:string){if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error("Invalid run/unit identifier");return value;}
export function safePath(path:string){if(!isAbsolute(path)||path.split(/[\\/]/).some(p=>p.toLowerCase()==="private"||p.toLowerCase().startsWith(".env"))||/[,\r\n]/.test(path))throw Error("Unsafe mount path");return path;}
export function mountPath(path:string){
  safePath(path);const absolute=resolve(path),tail:string[]=[];let ancestor=absolute;
  // Plans name directories that do not exist yet. Project them through the
  // nearest existing ancestor so a junction cannot hide a deeper bind source.
  while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)break;tail.unshift(basename(ancestor));ancestor=parent;}
  const physical=existsSync(ancestor)?resolve(realpathSync(ancestor),...tail):absolute;safePath(physical);
  for(const source of new Set([absolute,physical])){
    const depth=source.slice(parse(source).root.length).split(/[\\/]/).filter(Boolean).length;
    if(depth>16)throw Error(`Bind mount source has ${depth} levels (maximum 16): ${source}; Docker Desktop returned EIO from level 17 in acceptance; choose a shallower run root`);
  }
  return path;
}
export async function directory(path:string){safePath(path);await mkdir(path,{recursive:true});safePath(await realpath(path));return path;}
export const ownerFilter=["--filter",`label=${SEC1_LABELS.owner}=${SEC1_OWNER}`];
export const labels=(runId:string,unitId:string)=>["--label",`${SEC1_LABELS.owner}=${SEC1_OWNER}`,"--label",`${SEC1_LABELS.run}=${identifier(runId)}`,"--label",`${SEC1_LABELS.unit}=${identifier(unitId)}`];
export async function inspect(id:string){return JSON.parse((await docker(["inspect",id])).stdout)[0];}
export function assertOwned(info:any,runId?:string,unitId?:string,containerId?:string){const l=info.Config.Labels;if(!/^[a-f0-9]{64}$/.test(info.Id)||containerId!==undefined&&info.Id!==containerId)throw Error("Container identity mismatch");if(l?.[SEC1_LABELS.owner]!==SEC1_OWNER||runId!==undefined&&l[SEC1_LABELS.run]!==runId||unitId!==undefined&&l[SEC1_LABELS.unit]!==unitId)throw Error("Container ownership mismatch");}
export async function removeExited(id:string,runId?:string,unitId?:string){const info=await inspect(id);assertOwned(info,runId,unitId);if(info.State.Running)throw Error("Refusing to remove running container");await docker(["rm",info.Id]);}
