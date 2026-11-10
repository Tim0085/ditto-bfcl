import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,readFile,writeFile,readdir} from "node:fs/promises";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {block,egress,launchBlock,temporary,sleep,alive} from "./t7-helpers.ts";

const cases=["multi_turn_base_0","multi_turn_base_4","multi_turn_miss_func_0"];
const read=async(path:string)=>JSON.parse(await readFile(path,"utf8"));
const baseline=process.argv[2]==="baseline";
const explicitRoot=process.argv[3];
type Scenario={id:string;group?:"Direct"|"Monolithic";mode?:"kill"|"timeout";pythonCases?:string[];sharedCases?:string[];cleanupCases?:string[];stop?:boolean};

test(`T7 fix5 ${baseline?"unmodified baseline reproduction":"shared errors, real Python failure, cleanup, and streaks"}`,async()=>{
  const root=explicitRoot?resolve(explicitRoot):await temporary();await mkdir(root,{recursive:true});
  console.log(JSON.stringify({evidence:root,baseline}));
  const gateway=await egress(root,"replay");
  const outcomes:any[]=[];
  async function scenario(s:Scenario){
    const folder=join(root,s.id);await mkdir(folder);
    const pythonCases=s.pythonCases??[],events=join(folder,"injection.jsonl"),wrapper=join(folder,"bridge-wrapper.py");
    const cfg={pythonCases,sharedCases:s.sharedCases??[],cleanupCases:s.cleanupCases??[],events,wrapper,
      timeoutMs:s.mode==="timeout"?1500:10000};
    const pythonConfig={bridge:resolve("src/python/bridge.py"),directory:folder,cases:pythonCases};
    const helper=resolve("tests/t7-fix5-python.py");
    // JSON is decoded inside Python so Windows paths and Unicode remain literal.
    await writeFile(wrapper,`import json, runpy\nrunpy.run_path(${JSON.stringify(helper)}, init_globals={"FIX5": json.loads(${JSON.stringify(JSON.stringify(pythonConfig))})}, run_name="__main__")\n`);
    await writeFile(events,"");
    const hook=pathToFileURL(resolve("tests/t7-fix5-hook.mjs"));hook.searchParams.set("cfg",JSON.stringify(cfg));
    const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${old??""} --import=${hook.href}`;
    let running:Awaited<ReturnType<typeof launchBlock>>;
    try{running=await launchBlock(await block(folder,gateway.url,s.group??"Direct",s.id,1,cases));}
    finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
    let ended=false;void running.done.then(()=>{ended=true;},()=>{ended=true;});
    const killed=new Set<number>(),owned=new Map<number,any>(),holds=new Map<number,any>();
    const monitor=(async()=>{
      while(!ended){
        const entries=(await readFile(events,"utf8")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
        for(const entry of entries)if(entry.event==="owned-python")owned.set(entry.pid,entry);
        for(const name of (await readdir(folder)).filter(name=>/^python-\d+\.json$/.test(name))){
          let held:any;try{held=await read(join(folder,name));}catch{continue;}
          holds.set(held.pid,held);
          if(s.mode!=="kill"||killed.has(held.pid))continue;
          const owner=owned.get(held.pid);if(!owner)continue;
          assert.equal(owner.caseId,held.caseId);assert(pythonCases.includes(held.caseId));
          assert.equal(held.event,"tool-executed-response-held");assert(alive(held.pid));
          process.kill(held.pid,"SIGKILL");killed.add(held.pid);
          await writeFile(join(folder,`kill-${held.pid}.json`),JSON.stringify({signal:"SIGKILL",pid:held.pid,owner,held},null,2));
        }
        await sleep(15);
      }
    })();
    const result=await running.done;await monitor;
    const summary=await read(join(running.directory,"block-summary.json"));
    const failures=await Promise.all((await readdir(join(running.directory,"failures"))).sort().map(name=>read(join(running.directory,"failures",name))));
    const expectedStop=s.stop??false;
    assert.equal(result.code,expectedStop?1:0,JSON.stringify({s,result,summary}));
    assert.equal(summary.interrupted,0);assert.equal(summary.skipped,pythonCases.length+(s.sharedCases?.length??0)+(s.cleanupCases?.length??0));
    assert.equal(summary.notStarted,expectedStop?1:0);assert.equal(summary.completed,expectedStop?0:3-summary.skipped);
    const expectedCounts:Record<string,number>={};
    for(const failure of failures){
      const pythonFailure=pythonCases.includes(failure.caseId),sharedFailure=s.sharedCases?.includes(failure.caseId);
      const expected=pythonFailure?(baseline&&s.group!=="Monolithic"?"cleanup":"tool-channel"):sharedFailure?"context-error":"cleanup";
      expectedCounts[expected]=(expectedCounts[expected]??0)+1;
      assert.equal(failure.failureType,expected,JSON.stringify(failure));assert.equal(failure.disposition,"skipped");
      if(pythonFailure){
        assert.equal(failure.failureNode.node,"INTERACTION.ACT.TOOL");assert.equal(failure.errors.length,2);
        if(s.group!=="Monolithic")assert.equal(failure.errors[0],failure.errors[1]);
        assert(failure.errors.some((e:string)=>s.mode==="timeout"?/Python 响应超时（1500 ms）/.test(e):/Python 意外退出/.test(e)));
      }else if(sharedFailure){
        assert.equal(failure.failureNode.node,"CONTEXT.SELECT");assert.deepEqual(failure.errors,["fix5 shared context and cleanup","fix5 shared context and cleanup"]);
      }else{assert.equal(failure.failureNode,null);assert.deepEqual(failure.errors,["fix5 new cleanup failure"]);}
      assert.equal(failure.streak,expectedStop&&failure.caseId===cases[1]?2:1);
    }
    assert.deepEqual(summary.skippedByFailureType,expectedCounts);
    if(expectedStop)assert.deepEqual(summary.consecutiveFailure,{failureType:"tool-channel",caseIds:cases.slice(0,2)});
    else assert.equal(summary.consecutiveFailure,null);
    assert.equal(owned.size,pythonCases.length);assert.equal(holds.size,pythonCases.length);
    assert.equal(killed.size,s.mode==="kill"?pythonCases.length:0);
    for(const pid of owned.keys())assert.equal(alive(pid),false,`owned Python still alive: ${pid}`);
    const outcome={scenario:s,summary,failures,owned:[...owned.values()],held:[...holds.values()],killed:[...killed]};
    await writeFile(join(folder,"verified.json"),JSON.stringify(outcome,null,2));outcomes.push(outcome);
    console.log(JSON.stringify({id:s.id,group:s.group??"Direct",mode:s.mode,summary,failures:failures.map(f=>({caseId:f.caseId,failureType:f.failureType,failureNode:f.failureNode,errors:f.errors})),owned:[...owned.keys()],killed:[...killed]}));
  }
  try{
    if(baseline){
      for(const mode of ["kill","timeout"] as const)await scenario({id:`baseline-direct-${mode}`,mode,pythonCases:[cases[0]]});
      for(const mode of ["kill","timeout"] as const)await scenario({id:`baseline-monolithic-${mode}`,group:"Monolithic",mode,pythonCases:[cases[0]]});
    }else{
      await scenario({id:"shared-context",sharedCases:[cases[0]]});
      for(const mode of ["kill","timeout"] as const)for(let i=0;i<3;i++)await scenario({id:`direct-${mode}-${i}`,mode,pythonCases:[cases[0]]});
      for(const mode of ["kill","timeout"] as const)await scenario({id:`monolithic-${mode}`,group:"Monolithic",mode,pythonCases:[cases[0]]});
      await scenario({id:"new-cleanup",cleanupCases:[cases[0]]});
      await scenario({id:"different-streak",mode:"kill",pythonCases:[cases[0]],cleanupCases:[cases[1]]});
      await scenario({id:"same-streak",mode:"kill",pythonCases:cases.slice(0,2),stop:true});
    }
  }finally{await gateway.close();await writeFile(join(root,"outcomes.json"),JSON.stringify(outcomes,null,2));}
});
