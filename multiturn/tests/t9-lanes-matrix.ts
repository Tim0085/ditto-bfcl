// T9 segment A acceptance 2 and 3: 18 configurations, two lanes, 2 blocks, 4 tasks per configuration
// per block, local and container. Barriers are release files; overlap is read from recorded times.
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,cpSync,existsSync} from 'node:fs';
import {stage,comparisonView,command,referenceRoot} from './t8a-helpers.ts';
import {mainLanes,launch,until,groupStarted,unitExited,events,windows,peak,overlaps,release} from './t9-helpers.ts';
import {matrix,freeze,type Plan} from '../src/ts/scheduler/plan.ts';
import {read,json,lines,files,sleep,alive} from '../src/ts/scheduler/io.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {docker} from '../src/ts/docker/common.ts';
const root=resolve(process.argv[2]),split=resolve(process.argv[3]);mkdirSync(root,{recursive:true});
const cases=['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_miss_param_0','multi_turn_miss_param_4','multi_turn_miss_param_10','multi_turn_miss_param_36'];
const tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev';
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id;
const s=stage('t9-main-shape',cases);s.configs=matrix();s.targetedSplit=split;s.batches[0].configs=s.configs.map(c=>c.id);s.batches[0].lanes=mainLanes;s.blockSize=4;
s.launcher={kind:'docker',imageId,tag,runtime:{clockTicks:100,pageBytes:4096}};s.sampling.strict=true;s.stall={idleMs:180000,stopGraceMs:5000,pollMs:500};s.hostSampleMs=1000;
const local=structuredClone(s);local.launcher={kind:'local-process'};local.sampling.strict=false;
// Holds per block: the first three cases of a c1 config (a), its last case (b), all of c4, all of c8.
function holds(runRoot:string,plan:Plan,barriers:string){
 const map:Record<string,string>={};
 for(const job of plan.jobs)for(const unit of job.units){const c=s.configs.find(x=>x.id===unit.configId)!.c;unit.caseIds.forEach((caseId,i)=>{map[`${unit.configId}/${caseId}`]=release(barriers,c===1?(i===unit.caseIds.length-1?'c1b-':'c1a-')+job.category:`c${c}-${job.category}`);});}
 const path=join(barriers,'holds.json');json(path,map,true);return path;
}
async function run(kind:'docker'|'local',stageConfig:typeof s){
 const runRoot=join(root,kind),barriers=join(root,'barriers-'+kind);mkdirSync(barriers,{recursive:true});const plan=freeze(stageConfig,runRoot);json(join(root,`stage-${kind}.json`),stageConfig,true);
 const child=launch(root,runRoot,{egress:{holds:holds(runRoot,plan,barriers)}},kind);
 // Count what is really alive: labelled containers, or owned processes not collected yet.
 const count=async()=>{
  if(kind==='docker')return (await docker(['ps','-q','--no-trunc','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+s.runId])).stdout.trim().split(/\s+/).filter(Boolean).length;
  return files(join(runRoot,'blocks')).filter(p=>/logs.control\.json$/.test(p)&&!existsSync(join(p,'..','exit.json'))).filter(p=>{try{return alive(read(p).pid);}catch{return false;}}).length;
 };
 const samples:{at:string;count:number}[]=[];let polling=true,latest=0;
 const poller=(async()=>{while(polling){latest=await count();samples.push({at:new Date().toISOString(),count:latest});await sleep(250);}})();
 const running=()=>assert.equal(child.child.exitCode,null,'scheduler exited early: '+kind);
 const c4=mainLanes[1][0],c8=mainLanes[1][1];
 try{for(const job of plan.jobs){
  await until(()=>{running();return groupStarted(runRoot,job.key,2,1)&&latest===12;},'12 units up for '+job.key);
  for(const name of ['c1a-','c4-'])writeFileSync(release(barriers,name+job.category),'release');
  await until(()=>{running();return c4.every(c=>unitExited(runRoot,job.key,c))&&groupStarted(runRoot,job.key,2,2)&&latest===11;},'c8 group up beside lane 1 for '+job.key);
  for(const name of ['c1b-','c8-'])writeFileSync(release(barriers,name+job.category),'release');
  await until(()=>{running();return events(runRoot).some(e=>e.kind==='block-end'&&e.job===job.key);},'block end '+job.key);
  for(const c of [...c8,...mainLanes[0][0]])assert(unitExited(runRoot,job.key,c),'block-end before unit exit '+c);
 }
 assert.equal(await child.done,0,read(join(root,kind+'-process.json')).stderr);}
 catch(error){for(const job of plan.jobs)for(const name of ['c1a-','c1b-','c4-','c8-'])writeFileSync(release(barriers,name+job.category),'release after failure');await child.done;throw error;}
 finally{polling=false;await poller;}
 json(join(root,`poll-${kind}.json`),samples,true);
 assert.equal(read(join(runRoot,'scheduler','stop-report.json')).status,'complete');
 const rows=windows(runRoot,plan),proof:any[]=[];assert.equal(rows.length,36);assert(rows.every(r=>r.attempt===1&&Number.isFinite(r.start)&&Number.isFinite(r.end)));
 for(const job of plan.jobs){const own=rows.filter(r=>r.job===job.key),lane1=own.filter(r=>r.lane===1),first=own.filter(r=>r.lane===2&&r.laneGroup===1),second=own.filter(r=>r.lane===2&&r.laneGroup===2);
  assert.deepEqual([lane1.length,first.length,second.length],[5,7,6]);
  const firstEnd=Math.max(...first.map(r=>r.end)),secondStart=Math.min(...second.map(r=>r.start));assert(firstEnd<=secondStart,`c4 and c8 groups overlap in ${job.key}: ${firstEnd} > ${secondStart}`);
  assert(overlaps(lane1,first),'lane 1 overlaps c4 group');assert(overlaps(lane1,second),'lane 1 overlaps c8 group');
  // Every lane-1 unit individually overlaps every unit of both groups' time span.
  for(const r of lane1)assert(r.start<firstEnd&&r.end>secondStart,'each c1 unit spans the handover '+r.configId);
  proof.push({job:job.key,c4LastEnd:new Date(firstEnd).toISOString(),c8FirstStart:new Date(secondStart).toISOString(),gapMs:secondStart-firstEnd,lane1Start:new Date(Math.min(...lane1.map(r=>r.start))).toISOString(),lane1End:new Date(Math.max(...lane1.map(r=>r.end))).toISOString(),peakUnits:peak(own)});}
 const windowPeak=peak(rows),pollPeak=Math.max(...samples.map(r=>r.count));assert.equal(windowPeak,12,'recorded windows must peak at 12');assert.equal(pollPeak,12,'polling must peak at 12');
 const groups=events(runRoot).filter(e=>e.kind==='group-start');assert.equal(groups.length,6);
 for(const job of plan.jobs)for(const unit of job.units){const a=read(files(join(runRoot,'blocks',job.blockId,unit.configId)).find(p=>p.endsWith('attempt.json'))!);assert.equal(a.nonConcurrent,false);assert(Number.isInteger(a.lane)&&Number.isInteger(a.laneGroup));}
 return {kind,runRoot,plan,proof,windowPeak,pollPeak,pollSamples:samples.length,groupStarts:groups.length};
}
const dockerRun=await run('docker',s);
const localRun=await run('local',local);assert.deepEqual(localRun.plan.jobs,dockerRun.plan.jobs,'identical logical jobs, copies, seeds and orders');
const exportsProof:any[]=[];
for(const {kind,runRoot} of [dockerRun,localRun]){
 const exported=exportRun(runRoot,join(runRoot,'export-1'));exportRun(runRoot,join(runRoot,'export-2'));
 assert.equal(exported.taskRows.length,144);assert(exported.taskRows.every(r=>r.state==='completed'&&r.scoreStatus==='scored'&&r.nonConcurrent===false));
 for(const p of files(join(runRoot,'export-1')))assert(readFileSync(p).equals(readFileSync(p.replace('export-1','export-2'))),'export not byte-identical: '+p);
 for(const row of [...exported.taskRows,...exported.blockRows]){const expected=row.c===1?[1,1]:row.c===4?[2,1]:[2,2];assert.deepEqual([row.lane,row.laneGroup],expected,row.configId);}
 assert(exported.blockRows.every(r=>r.nonConcurrent===false));
 if(kind==='docker')for(const row of exported.summary)for(const key of ['cpuSeconds','gbSeconds'])assert(typeof row[key]==='number'&&Number.isFinite(row[key]),`${row.configId}/${row.category}: ${key}`);
 const meta=read(join(runRoot,'export-1','metadata.json'));assert.match(meta.laneRule,/nonConcurrent/);assert.equal(lines(join(runRoot,'export-1','scheduleEvents.jsonl')).filter(r=>r.kind==='group-start').length,6);
 comparisonView(runRoot,join(runRoot,'compare-input'));json(join(runRoot,'cases.json'),cases,true);
 const comp=await command(s.python,['-B','-X','utf8','scripts/compare.py','--new-run',join(runRoot,'compare-input'),'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(runRoot,'cases.json'),'--output',join(runRoot,'comparison')],join(runRoot,'comparison-process'));assert.equal(comp.code,0,comp.stdout+comp.stderr);
 exportsProof.push({kind,tasks:144,scored:144,exportByteIdentical:true,fourGatesAgainstOldRecord:'zero differences'});
}
// All 36 output configurations in one comparison: direct cross-deployment zero difference.
const combined=join(root,'combined'),requests:any[]=[];
for(const {kind,runRoot} of [dockerRun,localRun]){
 const input=join(runRoot,'compare-input');for(const cid of readdirSync(join(input,'configs'))){const newId=kind+'-'+cid,dst=join(combined,'configs',newId);mkdirSync(dst,{recursive:true});cpSync(join(input,'configs',cid),dst,{recursive:true});for(const p of files(dst).filter(p=>p.endsWith('.json'))){const data=read(p);data.configId=newId;writeFileSync(p,JSON.stringify(data));}}
 for(const row of lines(join(input,'egress','requests.jsonl')))requests.push({...row,configId:kind+'-'+row.configId});
}
mkdirSync(join(combined,'egress'),{recursive:true});writeFileSync(join(combined,'egress','requests.jsonl'),requests.map(r=>JSON.stringify(r)).join('\n')+'\n');json(join(root,'all-cases.json'),cases,true);
const cross=await command(s.python,['-B','-X','utf8','scripts/compare.py','--new-run',combined,'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(root,'all-cases.json'),'--output',join(root,'cross-comparison')],join(root,'cross-process'));assert.equal(cross.code,0,cross.stdout+cross.stderr);
assert.equal((await docker(['ps','-aq','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+s.runId])).stdout.trim(),'');
const result={status:'PASS',imageId,tag,deployments:[dockerRun,localRun].map(({kind,proof,windowPeak,pollPeak,pollSamples,groupStarts})=>({kind,proof,windowPeak,pollPeak,pollSamples,groupStarts})),exports:exportsProof,crossDeployment:'zero differences',ownerContainers:0,warning:'Offline engineering replay; barriers hold requests, so timing is not real-model performance.'};
json(join(root,'lanes-verification.json'),result,true);console.log(JSON.stringify(result));
