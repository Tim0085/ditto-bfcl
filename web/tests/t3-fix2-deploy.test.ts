import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { block, launchBlock, egress, fakeServer, alive } from "./t7-helpers.ts";

// Real fixture egress supplies the first successful response, then the proxy fails.
// c=1 proves immediate stop: the other two cases must never start.
for(const group of ["Direct","Monolithic"] as const) for(const fault of ["refused","reset","non-json","missing-fields"]) {
  test(`M2 config-main subprocess ${group}/${fault}`, async () => {
    const base=process.env.T3_FIX2_EVIDENCE ?? tmpdir();
    await mkdir(base,{recursive:true});
    const root=await mkdtemp(join(base,`t3-fix2-${group}-${fault}-`));
    const gateway=await egress(root,"fixtures");
    let requests=0, proxyClosed=false;
    let firstTask:string|undefined;
    const proxy=await fakeServer((body,res)=>{void(async()=>{
      requests++;
      if(firstTask === undefined) firstTask=body.taskId;
      assert.equal(body.taskId,firstTask,"no next task may start after egress failure");
      if(requests===1) {
        const response=await fetch(gateway.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
        const reply=await response.text();
        assert.equal(response.status,200);assert.equal(JSON.parse(reply).ok,true);
        if(fault==="refused") {
          // Stop listening before the successful response is consumed, preserving its active socket.
          const socket=res.socket!;
          await new Promise<void>(resolve=>res.end(reply,resolve));
          await proxy.close(); proxyClosed=true;
          assert(socket.destroyed || res.writableEnded);
        } else res.end(reply);
      } else if(fault==="reset") {
        res.writeHead(200,{"content-length":"10000"});res.write('{"ok":');setImmediate(()=>res.destroy());
      } else if(fault==="non-json") res.end("not json");
      else res.end(JSON.stringify({ok:true,output:{finishReason:"stop"}}));
    })().catch(error=>{console.error(error);res.destroy(error);});});
    try {
      const b=await block(root,proxy.url,group,`${group}-${fault}`,1,["multi_turn_base_0","multi_turn_base_4","multi_turn_base_8"]);
      const run=await launchBlock(b), done=await run.done;
      assert.equal(done.code,1,JSON.stringify(done));
      const summary=JSON.parse(await readFile(join(run.directory,"block-summary.json"),"utf8"));
      const names=await readdir(join(run.directory,"failures"));
      const failures=await Promise.all(names.map(n=>readFile(join(run.directory,"failures",n),"utf8").then(JSON.parse)));
      assert.equal(summary.completed,0);assert.equal(summary.skipped,0);assert.equal(summary.interrupted,1);assert.equal(summary.notStarted,2);
      assert.equal(failures.length,1);assert.equal(failures[0].category,"出口停止");assert.equal(failures[0].disposition,"interrupted");
      assert.match(JSON.stringify(failures[0]),/BFCL_RUN_STOP:/);
      if(fault==="refused")assert.match(summary.stopReason,/ECONNREFUSED/);
      if(fault==="reset")assert.match(summary.stopReason,/aborted|reset|hang up/i);
      assert.equal(requests,fault==="refused"?1:2);
      const lifecycle=JSON.parse(await readFile(join(run.directory,"lifecycle.json"),"utf8"));
      assert(lifecycle.processes.every((p:any)=>p.exited&&!alive(p.pid)));
      console.log(JSON.stringify({root,group,fault,requests,summary,failures,child:done}));
    } finally {if(!proxyClosed)await proxy.close();await gateway.close();}
  });
}
