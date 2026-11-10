import { readdirSync,readFileSync,existsSync,writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root=resolve(process.argv[2]),reports:any[]=[],seen=new Set<string>();
function scan(directory:string,expectedProbe=false){
  if(!existsSync(directory)||seen.has(directory))return;seen.add(directory);
  for(const name of readdirSync(directory).filter(n=>n.endsWith(".json"))){
    const file=join(directory,name),row=JSON.parse(readFileSync(file,"utf8"));if(!row.instance||!Array.isArray(row.children))continue;
    reports.push({...row,file,expectedProbe});
    for(const child of row.children){
      const at=child.args?.findIndex((x:string)=>x.endsWith("offline-guard-duplicate-probe.mjs"));
      if(at>=0){const dir=child.args[at+1];if(existsSync(dir))for(const d of readdirSync(dir).filter(n=>n.startsWith("reports-")))scan(join(dir,d),true);}
    }
  }
}
for(const directory of process.argv.slice(3))scan(resolve(directory));
const unique=[...new Map(reports.map(r=>[r.instance,r])).values()];
const allChildren=unique.flatMap(r=>r.children.map((c:any)=>({...c,parentPid:r.pid})));
const python=allChildren.filter(c=>/python(?:\.exe)?$/i.test(c.command));
if(python.some(c=>!c.args.includes("-B")))throw new Error("Python missing -B");
const normal=unique.filter(r=>!r.expectedProbe),probes=unique.filter(r=>r.expectedProbe);
if(normal.some(r=>r.deniedOperations!==0))throw new Error("Unexpected guard denial");
if(probes.some(r=>r.deniedOperations!==1))throw new Error("Guard self-test count changed");
const children=allChildren.filter(c=>c.isNode).map(c=>({parentPid:c.parentPid,pid:c.pid,launchId:c.launchId,
  reportPresent:unique.some(r=>r.launchId===c.launchId),guardRequested:c.guardRequested,
  note:unique.some(r=>r.launchId===c.launchId)?null:"No exit report; includes deliberate SIGKILL and bounded startup-timeout tests. Do not infer zero denied operations."}));
const result={nodeProcesses:unique.map(r=>({pid:r.pid,launchId:r.launchId,deniedOperations:r.deniedOperations,expectedProbe:r.expectedProbe,file:r.file})),
  normalReports:normal.length,normalDenied:normal.reduce((n,r)=>n+r.deniedOperations,0),selfTestReports:probes.length,selfTestExpectedDenied:probes.reduce((n,r)=>n+r.deniedOperations,0),children,pythonProcesses:python.map(c=>({parentPid:c.parentPid,pid:c.pid,args:c.args})),pythonAllB:true};
writeFileSync(join(root,"guard-summary.json"),JSON.stringify(result,null,2),{flag:"wx"});
const files=["worker-host","deploy","config-main","deploy-timeouts","resource-sampler","step-log","model-client"].map(n=>`src/ts/${n}.ts`)
  .concat(readdirSync("tests").filter(n=>/^t7-.*\.ts$/.test(n)).map(n=>"tests/"+n));
writeFileSync(join(root,"source-hashes.json"),JSON.stringify(files.map(path=>({path,sha256:createHash("sha256").update(readFileSync(path)).digest("hex")})),null,2),{flag:"wx"});
const matrix=join(root,"final-matrix","configs"),timing:any[]=[];
if(existsSync(matrix))for(const configId of readdirSync(matrix)){
  const readRows=(name:string)=>readFileSync(join(matrix,configId,name),"utf8").split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
  const steps=readRows("steps.jsonl"),events=readRows("graphs.jsonl");let graphs=0,minScheduleMs=Infinity;
  for(const start of events.filter(r=>r.event.status==="started")){
    const end=events.find(r=>r.taskId===start.taskId&&r.event.iteration===start.event.iteration&&r.event.status!=="started");assert(end);
    const own=steps.filter(s=>s.taskId===start.taskId&&s.graphId===start.event.graphId&&s.sent&&BigInt(s.sent.ns)>=BigInt(start.at.ns)&&BigInt(s.sent.ns)<=BigInt(end.at.ns));
    assert(own.length);const total=Number(BigInt(end.at.ns)-BigInt(start.at.ns))/1e6;
    const nodeIntervals=own.reduce((n,s)=>n+Number(BigInt(s.returned.ns)-BigInt(s.sent.ns))/1e6,0),schedule=total-nodeIntervals;
    assert(schedule>=-1e-6);minScheduleMs=Math.min(minScheduleMs,schedule);graphs++;
  }
  const endpoints=steps.flatMap(s=>s.started&&s.ended?[{ns:BigInt(s.started.ns),delta:1},{ns:BigInt(s.ended.ns),delta:-1}]:[]).sort((a,b)=>a.ns<b.ns?-1:a.ns>b.ns?1:a.delta-b.delta);
  let active=0,maxOverlap=0;for(const event of endpoints){active+=event.delta;maxOverlap=Math.max(maxOverlap,active);}
  if(configId==="direct-c8")assert.equal(maxOverlap,8);
  timing.push({configId,steps:steps.length,graphs,minGraphScheduleMs:graphs?minScheduleMs:null,maxOverlap,
    graphlessDiagnostics:steps.filter(s=>!s.execution&&s.action==="snapshot").length});
}
writeFileSync(join(root,"timing-checks.json"),JSON.stringify(timing,null,2),{flag:"wx"});
console.log(JSON.stringify({normalReports:result.normalReports,normalDenied:result.normalDenied,selfTestReports:result.selfTestReports,selfTestExpectedDenied:result.selfTestExpectedDenied,pythonProcesses:python.length,pythonAllB:true,missingExitReports:children.filter(c=>!c.reportPresent).length}));
