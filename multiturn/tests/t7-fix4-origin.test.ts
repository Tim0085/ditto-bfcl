import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,mkdirSync} from "node:fs";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {FailureTrace,ScoringTrace,failureScope,scoringScope,captureScoring,markFailure} from "../src/ts/step-log.ts";
import {checkContext,selectedMessages,STAGES,MessageCursor} from "../src/ts/graphs.ts";
import {temporary,block,launchBlock,fakeServer,sampleOutput} from "./t7-helpers.ts";

test("M4 source identity overrides node; successful/non-success returns do not lend their node to unrelated errors",async()=>{
  const trace=new FailureTrace("test"),unrelated=new Error("same text");
  await failureScope.run(trace,async()=>{
    await captureScoring("CONTEXT.LOAD",{},{},async()=>({items:[]}));
    assert.equal(trace.classify(unrelated),"other");
    assert.equal(trace.source(unrelated).node,null);
    await captureScoring("INFER.REASONING.SAMPLE",{},{},async()=>({status:"failed",error:{message:"same text"}}));
    assert.equal(trace.classify(unrelated),"other");
    for(const [node,type] of [["CONTEXT.SELECT","context-error"],["INTERACTION.ACT.TOOL","tool-channel"],["INFER.REASONING.SAMPLE","sample-not-success"],["MEMORY.WRITE","memory-not-success"]] as const){
      const e=new Error("same text");
      await assert.rejects(captureScoring(node,{},{},async()=>{throw e;}),x=>x===e);
      assert.equal(trace.classify(e),type);
      assert.equal(trace.source(e).node?.node,node);
    }
    const load=markFailure(new Error("same text"),"other");
    await assert.rejects(captureScoring("INTERACTION.ACT.TOOL",{},{},async()=>{throw load;}),e=>e===load);
    assert.equal(trace.classify(load),"other");
    assert.equal(trace.source(load).node,null);
    assert.equal(trace.classify(new Error("same text")),"other");
  });
});
test("M4 existing output checks tag the actual thrown object, including dropped SELECT and non-success status",()=>{
  const trace=new FailureTrace("test"),cursor=new MessageCursor();
  const items=cursor.messages([{role:"user",content:"one"},{role:"user",content:"two"}]);
  const throws=(work:()=>unknown,type:string)=>assert.throws(work,e=>trace.classify(e)===type);
  throws(()=>checkContext({items:[{id:"bad",metadata:{sequence:-1}}]}),"context-error");
  throws(()=>selectedMessages({context:{items:items.slice(0,1)},selectedItemIds:[items[0].id]},2),"context-error");
  for(const status of ["failed","cancelled","timeout"]){
    throws(()=>STAGES.think[1].validateOutput({status,error:{message:"opaque"}}),"sample-not-success");
    throws(()=>STAGES.save[0].validateOutput({status,error:{message:"opaque"}}),"memory-not-success");
  }
});
test("M4 first cause survives scoring and cleanup failures",async()=>{
  const trace=new FailureTrace("test"),score=new ScoringTrace("test");
  score.add=()=>{throw new Error("secondary scoring");};
  await failureScope.run(trace,()=>scoringScope.run(score,async()=>{
    const primary=markFailure(new Error("load failure"),"other");
    await assert.rejects(captureScoring("INTERACTION.ACT.TOOL",{},{},async()=>{throw primary;}),error=>{
      const chain=trace.precedingErrors.get(error)!;assert.equal(chain[0],primary);
      assert.equal(trace.classify(chain[0]),"other");assert.equal(trace.classify(chain[1]),"scoring-trace");
      assert.equal(trace.source(chain[0]).node,null);
      assert.equal(trace.source(chain[1]).node?.node,"INTERACTION.ACT.TOOL");
      const cleanup=new Error("cleanup");trace.causes.set(cleanup,"cleanup");assert.equal(trace.classify(cleanup),"cleanup");
      return true;
    });
  }));
});
for(const group of ["Direct","Monolithic","Uniform","Targeted"] as const)test(`M4 real ${group}: loading/no-usage then context never fabricate a same-type streak`,async()=>{
  const root=await temporary();console.log(JSON.stringify({root,group}));
  const cases=["multi_turn_base_0","multi_turn_base_4","multi_turn_base_6"];
  const plans=[
    {id:"load-nth1",load:{cases:[cases[0]],nth:1}},
    {id:"load-nth2-then-context",load:{cases:[cases[0]],nth:2},context:[{caseId:cases[1],type:"throw"}]},
    {id:"no-usage",noUsage:true,context:[{caseId:cases[1],type:"throw"}]},
    {id:"load-two-adjacent",load:{cases:cases.slice(0,2),nth:2},stop:true},
    {id:"publish-one",publish:{cases:[cases[0]]}},
    {id:"publish-two",publish:{cases:cases.slice(0,2)},stop:true},
    {id:"publish-and-failure",publish:{cases:[cases[0]],failures:true},fatalWrite:true},
    ...["drop","bad-sequence","bad-envelope"].map(type=>({id:"context-"+type,context:[{caseId:cases[0],type}]})),
    ...(group==="Direct"?[]:[{id:"worker-loading",load:{cases:[cases[0]],nth:1,scope:"worker"}}])
  ];
  for(const p of plans as any[]){
    const part=join(root,p.id);mkdirSync(part);
    const server=await fakeServer((body,res)=>{
      const output:any=structuredClone(sampleOutput);if(p.noUsage&&body.caseId===cases[0])delete output.usage;
      res.end(JSON.stringify({ok:true,output}));
    });
    const hook=pathToFileURL(resolve("tests/t7-fix4-origin-hook.mjs"));hook.searchParams.set("cfg",JSON.stringify(p));
    const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${old??""} --import=${hook.href}`;
    try{
      const b=await block(part,server.url,group,"probe",1,cases),run=await launchBlock(b),result=await run.done;
      const summary=JSON.parse(readFileSync(join(run.directory,"block-summary.json"),"utf8"));
      const failures=readdirSync(join(run.directory,"failures")).map(n=>JSON.parse(readFileSync(join(run.directory,"failures",n),"utf8")));
      if(p.fatalWrite){
        assert.equal(result.code,1);assert.equal(summary.skipped,0);assert.equal(summary.interrupted,1);
        assert.equal(summary.notStarted,2);assert.equal(summary.consecutiveFailure,null);assert.equal(failures.length,0);
        console.log(JSON.stringify({group,mode:p.id,summary,failures}));continue;
      }
      const first=failures.find(f=>f.caseId===cases[0]);assert(first);
      assert.equal(first.failureType,p.id.startsWith("context-")?"context-error":"other",JSON.stringify({p,first,result}));
      if(p.id.startsWith("context-"))assert.equal(first.failureNode?.node,"CONTEXT.SELECT",JSON.stringify(first));
      else assert.equal(first.failureNode,null,JSON.stringify(first));
      assert.equal(first.disposition,"skipped");
      assert.equal(summary.failed,summary.skipped+summary.interrupted);assert.equal(summary.skipped,failures.length);
      const counts:Record<string,number>={};for(const f of failures)counts[f.failureType]=(counts[f.failureType]??0)+1;
      assert.deepEqual(summary.skippedByFailureType,counts);
      assert.equal(summary.skippedByCategory.base,failures.length);
      if(p.stop){
        assert.equal(result.code,1);assert.equal(summary.notStarted,1);
        assert.deepEqual(summary.consecutiveFailure,{failureType:"other",caseIds:cases.slice(0,2)});
        assert.deepEqual(failures.map(f=>f.streak),[1,2]);
      }else{
        assert.equal(result.code,0,JSON.stringify(result));assert.equal(summary.notStarted,0);assert.equal(summary.consecutiveFailure,null);
        assert.equal(summary.completed,cases.length-failures.length);
        assert(failures.every(f=>f.streak===1));
        if(p.context&&p.context[0].caseId===cases[1]){
          const second=failures.find(f=>f.caseId===cases[1]);
          assert.equal(second.failureType,"context-error");assert.equal(second.failureNode?.node,"CONTEXT.SELECT");
        }
      }
      console.log(JSON.stringify({group,mode:p.id,summary,failures}));
    }finally{
      if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;
      await server.close();
    }
  }
});
