// Test-only fault injection. Disk sources and unrelated processes are untouched.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { childEnvironment } from "../src/ts/deploy.ts";
const [path,mode]=process.argv.slice(2),b=JSON.parse(fs.readFileSync(path,"utf8"));
const env=childEnvironment();for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,env);
const append=fs.appendFileSync,link=fs.linkSync;
if(mode==="recording")fs.appendFileSync=((path:any,...args:any[])=>{
  if(/(graphs|steps)\.jsonl$/.test(String(path)))throw new Error("T7 injected auxiliary write failure");return (append as any)(path,...args);
}) as any;
if(mode==="task-write")fs.linkSync=((source:any,path:any,...args:any[])=>{
  if(/[\\/]tasks[\\/]/.test(String(path)))throw new Error("T7 injected task result write failure");return (link as any)(source,path,...args);
}) as any;
if(mode==="failure-write")fs.linkSync=((source:any,path:any,...args:any[])=>{
  if(/[\\/]failures[\\/]/.test(String(path)))throw new Error("T7 injected failure persistence error");return (link as any)(source,path,...args);
}) as any;
syncBuiltinESMExports();
if(mode==="worker-recording"){
  const mkdir=fs.mkdirSync;
  fs.mkdirSync=((path:any,...args:any[])=>{
    const result=(mkdir as any)(path,...args);
    if(String(path).replaceAll("\\","/").endsWith("/workers"))mkdir(`${path}/All-1.steps.jsonl`,{recursive:true});
    return result;
  }) as any;
  syncBuiltinESMExports();
}
if(mode==="score-channel"){
  const {ScoringTrace}=await import("../src/ts/step-log.ts");
  ScoringTrace.prototype.add=()=>{throw new Error("T7 injected scoring channel failure");};
}
if(mode==="trace-validate"){
  const {ScoringTrace}=await import("../src/ts/step-log.ts"),validate=ScoringTrace.prototype.validate;
  ScoringTrace.prototype.validate=function(events,result){
    if(this.taskId.endsWith('/'+b.caseIds[1]))throw new Error("T7 injected trace mismatch");
    return validate.call(this,events,result);
  };
}
if(mode==="score-after-error"){
  const {ScoringTrace}=await import("../src/ts/step-log.ts"),add=ScoringTrace.prototype.add;
  ScoringTrace.prototype.add=function(node,input,result,identity,error){
    if(error||result?.status!=="success")throw new Error("T7 secondary scoring recorder failure");
    return add.call(this,node,input,result,identity,error);
  };
}
const {runBlock}=await import("../src/ts/config-main.ts");
const pending=runBlock(b);
if(mode==="sigterm"){
  // Windows cannot deliver POSIX SIGTERM; exercise the actual registered handler.
  const timer=setInterval(()=>{
    const file=`${b.outputRoot}/signal-ready`;
    if(fs.existsSync(file)){clearInterval(timer);process.emit("SIGTERM");}
  },10);pending.finally(()=>clearInterval(timer));
}
const summary=await pending;console.log(JSON.stringify(summary));process.exitCode=summary.exitCode;
