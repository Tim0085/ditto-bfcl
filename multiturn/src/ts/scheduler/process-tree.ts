import {execFile} from 'node:child_process';
import {platform} from 'node:os';
import {readdirSync,readFileSync} from 'node:fs';
import {env} from './io.ts';
export interface ProcessIdentity {pid:number;ppid:number;birth:string}
function born(p:ProcessIdentity){const ms=/Date\((\d+)/.exec(p.birth);return ms?Number(ms[1]):/^\d+$/.test(p.birth)?Number(p.birth):Date.parse(p.birth);}
export function descendants(before:ProcessIdentity[],rootPid:number){const tree=new Map<number,ProcessIdentity>(),root=before.find(p=>p.pid===rootPid);if(!root||!Number.isFinite(born(root)))return tree;tree.set(rootPid,root);let changed=true;while(changed){changed=false;for(const p of before){const parent=tree.get(p.ppid);if(!tree.has(p.pid)&&parent&&Number.isFinite(born(p))&&born(p)>=born(parent)){tree.set(p.pid,p);changed=true;}}}return tree;}
export async function findShell(specPath:string,report:string):Promise<number[]>{
 if(platform()==='win32'){const literal=specPath.replaceAll("'","''"), executable=process.execPath.replaceAll("'","''");return new Promise((yes,no)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',String.raw`@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executable}' -and $_.CommandLine -and $_.CommandLine.Contains('unit-shell.ts') -and $_.CommandLine -match ([regex]::Escape('${literal}') + '"?\s*$') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`],{windowsHide:true,timeout:20000,env:env(report)},(e,out)=>{if(e)return no(e);const result=out.trim()?JSON.parse(out):[];yes(Array.isArray(result)?result:[result]);}));}
 return readdirSync('/proc').filter(n=>/^\d+$/.test(n)).flatMap(n=>{try{const args=readFileSync(`/proc/${n}/cmdline`,'utf8').split('\0');return args.includes(specPath)&&args.some(a=>a.endsWith('/unit-shell.ts'))?[Number(n)]:[];}catch{return [];}});
}
async function inventory(report:string):Promise<ProcessIdentity[]>{
 if(platform()==='win32')return new Promise((yes,no)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],{windowsHide:true,timeout:20000,maxBuffer:4*1024*1024,env:env(report)},(e,out)=>e?no(e):yes(JSON.parse(out).map((r:any)=>({pid:r.ProcessId,ppid:r.ParentProcessId,birth:String(r.CreationDate)})))));
 return readdirSync('/proc').filter(n=>/^\d+$/.test(n)).flatMap(n=>{try{const s=readFileSync(`/proc/${n}/stat`,'utf8'),f=s.slice(s.lastIndexOf(')')+2).split(' ');return [{pid:Number(n),ppid:Number(f[1]),birth:f[19]}];}catch{return [];}});
}
/** Capture descendants of an authenticated root; recheck birth identity before each PID-only kill. */
export async function killOwnedTree(rootPid:number,report:string,authenticatedAt:string,beforeKill?:()=>void){const before=await inventory(report),tree=descendants(before,rootPid),root=tree.get(rootPid);if(!root)return [];
 if(platform()==='win32'&&born(root)>Date.parse(authenticatedAt))throw new Error('Root PID was reused after control identity was created');
 const current=new Map((await inventory(report)).map(p=>[p.pid,p])),killed:number[]=[];
 beforeKill?.(); // Final synchronous observation after potentially slow process inventories.
 for(const p of [...tree.values()].reverse()){if(current.get(p.pid)?.birth!==p.birth)continue;try{process.kill(p.pid,'SIGKILL');killed.push(p.pid);}catch(e){if((e as any).code!=='ESRCH')throw e;}}
 return killed;
}
