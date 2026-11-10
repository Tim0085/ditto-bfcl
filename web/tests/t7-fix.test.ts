import test from "node:test";
import assert from "node:assert/strict";
import { mkdir,writeFile,readFile,readdir,unlink } from "node:fs/promises";
import { join } from "node:path";
import { block,egress,temporary,command,python,sleep } from "./t7-helpers.ts";
import { resourceSampler } from "../src/ts/resource-sampler.ts";
import { lines } from "../src/ts/step-log.ts";

test("T7 fix M1 auxiliary losses remain scoreable, two reliable channel failures stop",async()=>{
  const root=await temporary(),gateway=await egress(root,"replay");
  console.log(JSON.stringify({evidence:root}));
  const errors:string[]=[];
  try{
    for(const [mode,group] of [["recording","Direct"],["worker-recording","Monolithic"],["score-channel","Direct"],["score-channel","Monolithic"]] as const){
      const id=mode+group,b=await block(root,gateway.url,group,id,1,["multi_turn_base_0","multi_turn_base_4"]),config=join(root,id+".json");
      await writeFile(config,JSON.stringify(b));
      const run=await command(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","tests/t7-fault-runner.ts",config,mode],join(root,id+".process.json"));
      const directory=join(root,"configs",id),summary=JSON.parse(await readFile(join(directory,"block-summary.json"),"utf8"));
      console.log(JSON.stringify({mode,group,exit:run.code,summary}));
      if(mode==="score-channel"){
        assert.equal(run.code,1);assert.equal(summary.completed,0);assert.equal(summary.failed,2);assert.equal(summary.notStarted,0);assert.equal(summary.skipped,2);
        assert.equal((await readdir(join(directory,"tasks"))).length,0);
        const failures=await readdir(join(directory,"failures"));assert.equal(failures.length,2);
        assert.match(await readFile(join(directory,"failures",failures[0]),"utf8"),/scoring channel failure/);
        continue;
      }
      assert.equal(run.code,0);assert.equal(summary.completed,2);
      const lost=mode==="recording"?summary.recordingFailures:summary.workerRecordingFailures["All-1"];
      assert(Object.values(lost).some((v:any)=>v.droppedRecords>0));
      for(const caseId of b.caseIds){
        const path=join(directory,"tasks",caseId+".r1.json"),scorePath=join(root,id+caseId+".score.json");
        const score=await command(python,["-B","-X","utf8","src/python/score.py","--input",path,"--output",scorePath],scorePath+".process.json");
        console.log(JSON.stringify({mode,group,caseId,score}));
        if(score.code!==0){errors.push(`${id}/${caseId}: ${score.stderr}`);continue;}
        const task=JSON.parse(await readFile(path,"utf8"));
        assert(task.workerEvents.every((e:any)=>e.kind&&e.status));
        assert(task.workerEvents.every((e:any)=>e.serviceMs===null&&e.nodeCpuUs===null&&e.performanceMissing.length>0));
        const oldScores=JSON.parse(await readFile("../../bfcl_direct/runs/multiturn-full800-001/full/multi_turn_base/monolithic/monolithic-c1/score.json","utf8")).results;
        const old=oldScores.find((r:any)=>r.caseId===caseId),actual=JSON.parse(await readFile(scorePath,"utf8"));
        assert(old);assert.equal(actual.valid,old.valid);assert.deepEqual(actual.official_result,old.official_result);
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await gateway.close();}
});

test("T7 fix M2 process availability, all proc files, initial and periodic strict failures",async()=>{
  const root=await temporary(),cgroup=join(root,"cgroup"),proc=join(root,"proc");await mkdir(cgroup);await mkdir(proc);
  const b=await block(root,"http://127.0.0.1:1"),options={...b.sampling,cgroupDirectory:cgroup,procDirectory:proc,intervalMs:10,processIntervalMs:1};
  for(const [name,value] of Object.entries({"cpu.stat":"usage_usec 12345","memory.current":"4096","cpu.max":options.expected.cpuMax,"memory.max":options.expected.memoryMax,"memory.swap.max":"0","cgroup.procs":"21\n22"}))await writeFile(join(cgroup,name),value);
  const fields=Array(22).fill("0");fields[0]="S";fields[1]="1";fields[11]="20";fields[12]="30";
  const content={stat:`22 (process name) ${fields.join(" ")}`,statm:"10 3",cmdline:"python\0-B\0bridge.py"};
  for(const pid of [21,22]){await mkdir(join(proc,String(pid)));for(const [n,v] of Object.entries(content))await writeFile(join(proc,String(pid),n),v);}
  const once=async(name:string,strict=false)=>{const path=join(root,name+".jsonl"),s=await resourceSampler(path,{...options,strict},()=>[],()=>assert.fail());await s.stop();return lines(path).find(r=>r.kind==="processes");};
  const full=await once("full");console.log(JSON.stringify({available:full.available}));assert.equal(full.available,true);
  for(const file of ["stat","statm","cmdline"] as const){
    if(file==="cmdline")await unlink(join(proc,"22",file));else await writeFile(join(proc,"22",file),"broken");
    const row=await once(file);console.log(JSON.stringify({file,available:row.available,rows:row.rows}));assert.equal(row.available,"partial");
    const bad=row.rows.find((r:any)=>r.pid===22);assert.equal(bad.cpuSeconds,null);assert.equal(bad.rssBytes,null);assert(bad.reasons.length>0);
    await assert.rejects(once(file+"-strict",true),/22/);
    await writeFile(join(proc,"22",file),content[file]);
  }
  await unlink(join(cgroup,"cgroup.procs"));const unavailable=await once("unavailable");console.log(JSON.stringify({available:unavailable.available}));assert.equal(unavailable.available,false);
  await writeFile(join(cgroup,"cgroup.procs"),"21\n22");
  let failure:unknown;const sampler=await resourceSampler(join(root,"periodic.jsonl"),{...options,strict:true},()=>[],e=>failure=e);
  try{await writeFile(join(proc,"22","stat"),"broken");for(let i=0;i<100&&!failure;i++)await sleep(10);assert.match(String(failure),/22/);}finally{await sampler.stop();}
  console.log(JSON.stringify({periodicStrictStopped:!!failure,evidence:root}));
});
