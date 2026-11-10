import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {readFileSync,existsSync,mkdirSync,writeFileSync} from "node:fs";
import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";
import {temporary,block,launchBlock,sleep,sampleOutput} from "./t7-helpers.ts";
const rows=(p:string)=>existsSync(p)?readFileSync(p,"utf8").split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)):[];
for(const group of ["Direct","Monolithic"] as const)test(`M1 real config-main ${group}: exact bytes, retries 1/2/3, exhausted, reset, bad JSON, cancel`,async()=>{
  const root=await temporary();console.log(JSON.stringify({group,root}));
  let baseline:string[]=[];
  for(const mode of ["baseline","retry1","retry2","retry3","exhausted","reset","bad-json","cancel"]){
    const dir=join(root,mode);mkdirSync(dir);const trace=join(dir,"sockets.jsonl");
    const bodies:string[]=[],active=new Set<string>();let overlap=0,connections=0;
    const server=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const raw=Buffer.concat(chunks).toString();bodies.push(raw);const body=JSON.parse(raw);
      if(active.has(body.taskId))overlap++;active.add(body.taskId);res.once("close",()=>active.delete(body.taskId));
      if(mode==="reset"){res.destroy();return;}
      res.end(mode==="bad-json"?"bad JSON":JSON.stringify({ok:true,output:sampleOutput}));
    });
    server.on("connection",()=>connections++);server.listen(0,"127.0.0.1");await once(server,"listening");
    const port=(server.address() as any).port;
    const delayed=mode.startsWith("retry")||mode==="exhausted"||mode==="cancel";
    if(delayed)await new Promise<void>(r=>server.close(()=>r()));
    const hook=pathToFileURL(resolve("tests/t7-fix4-network-hook.mjs"));
    hook.searchParams.set("port",String(port));hook.searchParams.set("file",trace);if(mode==="cancel")hook.searchParams.set("cancel","yes");
    const previous=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${previous??""} --import=${hook.href}`;
    let timer:ReturnType<typeof setInterval>|undefined;
    try{
      const count=mode.startsWith("retry")?Number(mode.at(-1)):0;
      if(count)timer=setInterval(()=>{
        if(rows(trace).filter(r=>r.event==="close").length>=count){clearInterval(timer);server.listen(port,"127.0.0.1");}
      },10);
      const b=await block(dir,`http://127.0.0.1:${port}`,group,"test");
      if(["exhausted","reset","bad-json"].includes(mode))b.caseIds.push("multi_turn_base_4");
      const started=performance.now(),run=await launchBlock(b),result=await run.done;
      const elapsed=performance.now()-started,summary=JSON.parse(readFileSync(join(run.directory,"block-summary.json"),"utf8"));
      const steps=rows(join(run.directory,"steps.jsonl")).filter(r=>r.node==="INFER.REASONING.SAMPLE");
      const events=rows(trace),attempts=events.filter(r=>r.event==="attempt"),errors=events.filter(r=>r.event==="error");
      if(mode==="baseline"||count){
        assert.equal(result.code,0,JSON.stringify(result));assert.equal(summary.completed,1);
        if(!count)baseline=bodies;else assert.deepEqual(bodies,baseline);
        assert.equal(steps[0].connectRetries,count);
        const planned=[0,1000,3000,7000][count];
        assert(steps[0].connectRetryWaitMs>=planned-30);assert(steps[0].connectRetryWaitMs<planned+2000);
        assert.equal(errors.length,count);
        for(let i=0;i<count;i++){
          const closed=events.find(r=>r.event==="close"&&r.pid===attempts[i].pid&&r.id===attempts[i].id)!;
          const gap=attempts[i+1].at-closed.at;assert(gap>=[1000,2000,4000][i]-30);assert(gap<[1000,2000,4000][i]+2000);
        }
      }else if(mode==="cancel"){
        assert.equal(attempts.length,1);assert.equal(steps[0].connectRetries,0);assert(steps[0].connectRetryWaitMs<800);
        assert(!steps[0].error.includes("BFCL_RUN_STOP:"));assert.match(steps[0].error,/fix4 cancel/);
        server.listen(port,"127.0.0.1");await once(server,"listening");await sleep(1200);assert.equal(connections,0);
      }else{
        assert.equal(result.code,1);assert.equal(summary.interrupted,1);assert.equal(summary.skipped,0);
        assert.equal(summary.stopCategory,"出口停止");assert.match(steps[0].error,/BFCL_RUN_STOP:/);
        assert.equal(summary.notStarted,1);
        if(mode==="exhausted"){
          assert.equal(attempts.length,4);assert.equal(errors.length,4);assert.equal(steps[0].connectRetries,3);
          assert.match(steps[0].error,/"attempts":4/);assert(steps[0].connectRetryWaitMs>=6970);
        }else{assert.equal(attempts.length,1);assert.equal(steps[0].connectRetries,0);assert.equal(bodies.length,1);}
      }
      assert.equal(overlap,0);
      const evidence={group,mode,elapsed,connections,overlap,attempts:attempts.length,errors,metrics:steps.map(r=>({connectRetries:r.connectRetries,connectRetryWaitMs:r.connectRetryWaitMs,error:r.error})),summary};
      writeFileSync(join(dir,"assertions.json"),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
    }finally{
      if(timer)clearInterval(timer);
      if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;
      server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    }
  }
});
