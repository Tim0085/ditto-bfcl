import {join,relative,basename} from 'node:path';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {ROOT,files,read,json,auxiliaryLines,env} from '../src/ts/scheduler/io.ts';
const evidence=join(ROOT,'runs/offline/t8a-20261105'),paths=files(evidence);
const archives=paths.filter(p=>p.endsWith('-archive.json')&&!p.includes(join('artifacts',''))).map(p=>read(p)).filter(r=>r.source&&r.target);
const processEvidence=new Map<number,number>(),expectedNames=new Map<number,Map<string,number>>(),add=(pid:any,at:number,name='node.exe')=>{if(Number.isSafeInteger(pid)&&pid>0&&Number.isFinite(at)){processEvidence.set(pid,Math.max(processEvidence.get(pid)??0,at));const names=expectedNames.get(pid)??new Map<string,number>();names.set(name.toLowerCase(),Math.max(names.get(name.toLowerCase())??0,at));expectedNames.set(pid,names);}};
function originalTime(path:string){const archive=archives.find(a=>path.startsWith(a.target+'\\')||path.startsWith(a.target+'/'));const original=archive?join(archive.source,relative(archive.target,path)):path;return statSync(existsSync(original)?original:path).mtimeMs;}
const reports=new Map<string,any>();
for(const path of paths.filter(p=>/^\d+-[a-f0-9-]{36}\.json$/.test(basename(p)))){const r=read(path);if(r.offlineGuard!==true)continue;reports.set(r.instance,r);const at=originalTime(path);add(r.pid,at);for(const child of r.children??[])add(child.pid,at,child.isNode?'node.exe':basename(child.command));}
// Keep authoritative wall-clock observations for killed parents with no exit guard report.
for(const path of paths.filter(p=>p.endsWith('control.json'))){const row=read(path);add(row.pid,Date.parse(row.startedAt));}
for(const path of paths.filter(p=>p.endsWith('.steps.jsonl')||p.endsWith('/steps.jsonl')||p.endsWith('\\steps.jsonl')))for(const row of auxiliaryLines(path)){const at=Date.parse(row.ended?.wall??row.started?.wall??row.received?.wall??'');add(row.pid,at);add(row.pythonPid,at,'python.exe');}
const launches=[...reports.values()].flatMap(r=>r.children??[]),python=launches.filter(r=>/(^|[\\/])python(?:\.exe)?$/i.test(r.command??''));
const launchReports=new Set([...reports.values()].map(r=>r.launchId).filter(Boolean)),missing=launches.filter(r=>r.isNode&&!launchReports.has(r.launchId)).map(r=>({pid:r.pid,launchId:r.launchId,command:r.command,args:r.args,guardRequested:r.guardRequested}));
const seenMissing=new Map(missing.map(r=>[r.launchId,r]));
const inventory=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CreationDate | ConvertTo-Json -Compress'],{windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024,env:env(join(evidence,'audit-guards'))}));
const present=inventory.filter((r:any)=>processEvidence.has(r.ProcessId)).map((r:any)=>{const birth=String(r.CreationDate),match=/Date\((\d+)/.exec(birth),born=match?Number(match[1]):Date.parse(birth),names=expectedNames.get(r.ProcessId)!,last=names.get(r.Name.toLowerCase()),nameMismatch=last===undefined;return {pid:r.ProcessId,name:r.Name,born,lastObserved:last??processEvidence.get(r.ProcessId),nameMismatch,reused:nameMismatch||Number.isFinite(born)&&born>last!+1000};});
const suspects=present.filter((r:any)=>!r.reused&&r.pid!==process.pid);
const result={guardReports:reports.size,observedDenied:[...reports.values()].reduce((n,r)=>n+(r.deniedOperations??0),0),pythonLaunches:python.length,pythonWithoutB:python.filter(r=>!r.args.includes('-B')),missingNodeExitReports:[...seenMissing.values()],observedPids:processEvidence.size,present,suspects,
  scratchRetained:archives.map(a=>({source:a.source,archive:a.target,exists:existsSync(a.source)})),cleanup:'Deletion rejected by automatic approval review; no bypass attempted'};
json(join(evidence,(process.argv[2]??'final-audit')+'.json'),result,true);
console.log(JSON.stringify({guardReports:result.guardReports,observedDenied:result.observedDenied,pythonLaunches:result.pythonLaunches,pythonWithoutB:result.pythonWithoutB.length,missingNodeExitReports:result.missingNodeExitReports.length,observedPids:result.observedPids,present,suspects,retainedScratchDirectories:result.scratchRetained.filter(r=>r.exists).length}));
if(result.pythonWithoutB.length||result.observedDenied||suspects.length)process.exitCode=1;
