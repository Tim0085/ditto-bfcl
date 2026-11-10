import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,readdir,writeFile,cp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { DockerLauncher } from '../src/ts/docker/launcher.ts';
import type { RunUnitSpec } from '../src/ts/run-unit.ts';
import { docker,inspect,labels,removeExited,save } from '../src/ts/docker/common.ts';
import { scoreInContainer } from '../scripts/docker-score.ts';
import { block,egress,launchBlock,command,python } from './t7-helpers.ts';
import { scoreDifference } from './t8b-score-diff.ts';
const evidence=resolve('runs/offline/t8b-20261105');
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'matrix-'));console.log(JSON.stringify({root}));
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
const probe=(await docker(['create','--pull=never',...labels('t8b-matrix','runtime'),'--network','none',imageId,'python3','-B','-c',`import os,json;print(json.dumps(dict(clockTicks=os.sysconf('SC_CLK_TCK'),pageBytes=os.sysconf('SC_PAGE_SIZE'))))`])).stdout.trim();
await docker(['start',probe]);await docker(['wait',probe]);const runtime=JSON.parse((await docker(['logs',probe])).stdout);await removeExited(probe,'t8b-matrix','runtime');
console.log(JSON.stringify({imageId,runtime}));await save(join(evidence,'runtime.json'),{imageId,runtime});
const launcher=new DockerLauncher(imageId,runtime);
const cases=['multi_turn_base_0','multi_turn_miss_func_0','multi_turn_miss_param_0','multi_turn_long_context_0'];
const gateway=await egress(root,'replay');
let gatewayClosed=false;
const units:Awaited<ReturnType<typeof launcher.start>>[]=[];
try{
  const specs:RunUnitSpec[]=[];
  for(const group of ['Direct','Monolithic','Uniform','Targeted'] as const){
    const b=await block(root,gateway.url,group,group+'-docker',group==='Direct'?1:8,cases);b.runId='t8b-matrix';
    if(group==='Uniform')b.copies={Context:8,Infer:8,Interaction:8,Memory:8};
    if(group==='Targeted')b.copies={Context:1,Infer:8,Interaction:1,Memory:1};
    b.sampling.strict=true;
    const spec:RunUnitSpec={runId:b.runId,unitId:b.configId,block:{...b},outputRoot:root,logDir:join(root,'units',b.configId),guardReportDir:join(root,'guards',b.configId),egressUrl:gateway.url};
    specs.push(spec);units.push(await launcher.start(spec));
  }
  const exits=await Promise.all(units.map(unit=>unit.wait()));console.log(JSON.stringify({exits}));
  assert(Math.max(...exits.map(e=>Date.parse(e.startedAt)))<Math.min(...exits.map(e=>Date.parse(e.endedAt))),'all four containers overlap');
  for(const [i,exit] of exits.entries()){
    assert.equal(exit.exitCode,0,JSON.stringify({spec:specs[i],exit}));assert.equal(exit.oomKilled,false);assert(exit.startedAt&&exit.endedAt);assert.equal((exit.summary as any).completed,4);
    const spec=specs[i];const resources=(await readFile(join(root,'configs',spec.unitId,'resources.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
    assert(resources.length>0);assert(resources.every(r=>r.available===true));
    const processRows=resources.flatMap(r=>r.rows??[]);assert(processRows.some(r=>r.pid===1&&r.role==='main'&&r.cpuSeconds!==null&&r.rssBytes!==null));
    for(const row of processRows.filter(r=>r.command?.includes('/src/python/bridge.py')&&!r.exitedDuringSample))assert.equal(row.role,'python');
    const guards=await readdir(spec.guardReportDir);assert.equal(guards.length,1+(spec.block.group==='Direct'?0:Object.values(spec.block.copies as Record<string,number>).reduce((a,b)=>a+b,0)));
    for(const name of guards){const report=JSON.parse(await readFile(join(spec.guardReportDir,name),'utf8'));assert.equal(report.deniedOperations,0);assert.equal(report.initializations,1);}
    const pids=(await readFile(join(spec.logDir,'pids.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));console.log(JSON.stringify({unit:spec.unitId,threadPeak:Math.max(...pids.map(p=>p.peak)),resourceSamples:resources.length,guardReports:guards.length}));
    const b=structuredClone(spec.block) as any;b.configId=String(b.group)+'-local';b.sampling.strict=false;
    const local=await launchBlock(b);assert.equal((await local.done).code,0);
    for(const caseId of cases){
      const input=join(root,'configs',spec.unitId,'tasks',caseId+'.r1.json');const hostScore=join(root,'scores',spec.unitId,caseId+'.host.json');await mkdir(join(root,'scores',spec.unitId),{recursive:true});
      const scored=await command(python,['-B','-X','utf8','src/python/score.py','--input',input,'--output',hostScore],hostScore+'.process.json');assert.equal(scored.code,0,JSON.stringify(scored));
      const containerScore=join(root,'scores',spec.unitId,caseId+'.container.json');await scoreInContainer(imageId,input,containerScore,join(root,'score-logs'));
      const diff=scoreDifference(await readFile(hostScore),await readFile(containerScore));await save(hostScore+'.difference.json',diff);
      console.log(JSON.stringify({config:spec.unitId,caseId,hostBytes:diff.host.bytes,containerBytes:diff.container.bytes,hostLines:diff.host.lines,containerLines:diff.container.lines,differenceCount:diff.differenceCount,onlyNewlineDifference:true}));
    }
  }
  await gateway.close();gatewayClosed=true;
  const casesFile=join(root,'cases.json');await writeFile(casesFile,JSON.stringify(cases));
  const compare=await command(python,['-B','-X','utf8','scripts/compare.py','--new-run',root,'--old-run','../../bfcl_direct/runs/multiturn-full800-001','--cases',casesFile,'--output',root+'-comparison'],join(root,'compare-process.json'));
  console.log(JSON.stringify(compare));assert.equal(compare.code,0);assert.deepEqual(await launcher.list('t8b-matrix'),[]);
  console.log('PASS: four simultaneous containers; same local replay; scoring equality except explicitly accepted newlines; four gates and cross-deployment');
}catch(error){
  if(!gatewayClosed)await gateway.close();throw error;
}finally{
  // Preserve failed runs as evidence as well. Never kill automatically: callers must check egress first.
  await cp(root,join(evidence,'raw',root.split(/[\\/]/).at(-1)!),{recursive:true});
  try{await cp(root+'-comparison',join(evidence,'raw',root.split(/[\\/]/).at(-1)!+'-comparison'),{recursive:true});await rm(root+'-comparison',{recursive:true});}catch(e:any){if(e.code!=='ENOENT')throw e;}
  if((await launcher.list('t8b-matrix')).length===0){assert(root.startsWith(parent));await rm(root,{recursive:true});}
}
