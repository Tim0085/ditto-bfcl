import test from "node:test";
import assert from "node:assert/strict";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {mkdir} from "node:fs/promises";
import {block,temporary,fakeServer,sampleOutput,command} from "./t7-helpers.ts";
import {deploy} from "../src/ts/deploy.ts";
import {deployTimeouts} from "../src/ts/deploy-timeouts.ts";
test("T7 fix3 fatal failure replies are interrupted in both orders",async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));
  const r=await command(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","tests/t7-fix3-crash.ts",root,"1"],join(root,"crash-process.json"));
  assert.equal(r.code,0,JSON.stringify(r));
});
test("T7 fix3 volume and merge exceptions preserve tasks failures summary and scoring",async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));
  for(const mode of ["volume","merge-error"]){
    const part=join(root,mode);await mkdir(part);
    const hook=pathToFileURL(resolve("tests/t7-fix2-hook.mjs"));hook.searchParams.set("faults",JSON.stringify([{caseId:"multi_turn_base_4",type:"context-error"}]));
    const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${old??""} --import=${hook.href}`;
    try{
      const r=await command(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","tests/t7-fix3-volume.ts",part,mode],join(part,"process.json"));
      assert.equal(r.code,0,JSON.stringify(r));
    }finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
  }
});
test("T7 fix3 ping confirms identity, bounds silence, handles send errors and missing workers",async()=>{
  const directory=await temporary();console.log(JSON.stringify({evidence:directory}));
  const server=await fakeServer((_body,res)=>res.end(JSON.stringify({ok:true,output:sampleOutput})));
  const b=await block(directory,server.url,"Monolithic"),timeouts=deployTimeouts(b.egress);
  const pool=await deploy({group:"Monolithic",copies:{All:1},python:b.python,modelEndpoint:server.url,directory,timeouts});
  try{
    assert.equal((await pool.confirmAlive(["All-1"]))[0].method,"pong");
    assert.equal((await pool.confirmAlive(["unknown"]))[0].alive,false);
    const child=pool.units[0].child,send=child.send.bind(child);
    const before={message:child.listenerCount("message"),disconnect:child.listenerCount("disconnect")};
    timeouts.handshakeTimeoutMs=50;
    try{
      child.send=((..._args:any[])=>true) as any;
      assert.equal((await pool.confirmAlive(["All-1"]))[0].method,"timeout");
      child.send=(()=>{throw new Error("injected ping send failure");}) as any;
      assert.equal((await pool.confirmAlive(["All-1"]))[0].method,"send-error");
    }finally{child.send=send;}
    assert.deepEqual({message:child.listenerCount("message"),disconnect:child.listenerCount("disconnect")},before);
  }finally{await pool.close();await server.close();}
});
test("T7 fix3 run_stop closes admission before slow liveness confirmation",async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));
  const r=await command(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","tests/t7-fix3-stop.mjs",root],join(root,"stop-process.json"));
  assert.equal(r.code,0,JSON.stringify(r));
});
