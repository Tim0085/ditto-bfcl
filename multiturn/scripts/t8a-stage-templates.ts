import {join} from 'node:path';
import {matrix,categories,type StageConfig} from '../src/ts/scheduler/plan.ts';
import {read,json,ROOT} from '../src/ts/scheduler/io.ts';
const all=matrix(),egress=read(join(ROOT,'config/egress.offline.json'));
const common={version:1 as const,seed:20261105,rounds:1,blockSize:50,python:'python',egress,endpoint:{host:'127.0.0.1' as const,port:0},sampling:{enabled:true,strict:false,expected:{cpuMax:'200000 100000',memoryMax:'4294967296',swapMax:'0'},intervalMs:200,processIntervalMs:1000},startupConcurrency:4,stall:{idleMs:900000,stopGraceMs:30000,pollMs:1000},score:{timeoutMs:120000,concurrency:4},hostSampleMs:2000};
const pilot=all.filter(c=>['direct-c1','mono-1-c1','uniform-8-c1','targeted-8-c1','mono-8-c8','uniform-8-c8','targeted-8-c8'].includes(c.id));
const solo={...all.find(c=>c.id==='mono-8-c8')!,id:'mono-8-c8-solo',comparison:['solo']};
const stages:StageConfig[]=[
 {...common,runId:'profile-001',stage:'profile',configs:[all.find(c=>c.id==='uniform-8-c1')!],batches:[{id:'profile',configs:['uniform-8-c1'],caseIds:'profile'}]},
 {...common,runId:'pilot-001',stage:'pilot',targetedSplit:'TARGETED_SPLIT_REQUIRED.json',configs:pilot,batches:[{id:'pilot',configs:pilot.map(c=>c.id),caseIds:categories.flatMap(c=>[21,22].map(n=>c+'_'+n))}]},
 {...common,runId:'slice-001',stage:'slice',targetedSplit:'TARGETED_SPLIT_REQUIRED.json',configs:[...all,solo],batches:[{id:'together',configs:all.map(c=>c.id),caseIds:categories.flatMap(c=>[21,22,23,24,25].map(n=>c+'_'+n))},{id:'solo',configs:[solo.id],caseIds:categories.flatMap(c=>[21,22,23,24,25].map(n=>c+'_'+n))}]},
 {...common,runId:'main-001',stage:'main',rounds:3,targetedSplit:'TARGETED_SPLIT_REQUIRED.json',configs:all,batches:[{id:'main',configs:all.map(c=>c.id),caseIds:'all'}]},
];
for(const stage of stages)json(join(ROOT,'config/stages',stage.stage+'.json'),stage,true);
console.log('Created four offline stage templates; real runs require separate authorization and frozen settings.');
