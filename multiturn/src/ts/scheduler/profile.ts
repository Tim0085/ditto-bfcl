import {isSample,reconnect} from './reconnect.ts';
import {join} from 'node:path';
import {read,lines,json,digest} from './io.ts';
import {categories,capabilities,profileNumbers,type Plan} from './plan.ts';
import {merged,attempts,sourceRef} from './records.ts';
export function optimize(A:Record<string,number>){
  if(capabilities.some(k=>!Number.isFinite(A[k])||A[k]<0))throw new Error('Missing or invalid profiling time');
  let best:number[]|undefined,minimum=Infinity;
  // Lexicographic tie-break in Context, Infer, Interaction, Memory order.
  for(let a=1;a<=5;a++)for(let b=1;b<=6-a;b++)for(let c=1;c<=7-a-b;c++){const d=8-a-b-c;if(d<1)continue;const allocation=[a,b,c,d],value=Math.max(...capabilities.map((k,i)=>A[k]/allocation[i]));if(value<minimum){minimum=value;best=allocation;}}
  if(best!.every(n=>n===2))throw new Error('Targeted equals Uniform (2/2/2/2); stop and report');
  return {copies:Object.fromEntries(capabilities.map((k,i)=>[k,best![i]])),objectiveMs:minimum};
}
export function profile(root:string,output:string){const plan=read<Plan>(join(root,'plan.json')),byCategory:Record<string,any>={};
  for(const category of categories){const jobs=plan.jobs.filter(j=>j.category===category);const ids=jobs.flatMap(j=>j.caseIds).sort();if(JSON.stringify(ids)!==JSON.stringify(profileNumbers.map(n=>category+'_'+n).sort()))throw new Error('Profiling requires exactly the fixed 8 cases per category');
    let connectRetries=0,connectRetryWaitMs=0;const A=Object.fromEntries(capabilities.map(k=>[k,0])),sources:any[]=[];
    for(const job of jobs){if(job.round!==1||job.units.length!==1)throw new Error('Invalid profiling round/config');const cid=job.units[0].configId,cfg=plan.stage.configs.find(c=>c.id===cid)!;
      if(cfg.group!=='Uniform'||cfg.c!==1||Object.values(job.units[0].copies!).some(n=>n!==2))throw new Error('Profiling must use Uniform8/c1');
      const history=attempts(root,job,cid);if(history.length!==1)throw new Error('Profiling interrupted or retried; no allocation published');
      const map=merged(root,job,cid);if(map.size!==job.caseIds.length||[...map.values()].some(r=>r.kind!=='tasks'))throw new Error('Profiling has failed/skipped/interrupted/missing cases');
      const directory=join(history[0].path,'output','configs',cid),summary=read(join(directory,'block-summary.json'));
      if(summary.exitCode!==0||summary.failed||summary.notStarted)throw new Error('Profiling did not finish cleanly');
      if(Object.keys(summary.recordingFailures??{}).length||Object.values(summary.workerRecordingFailures??{}).some((r:any)=>Object.keys(r??{}).length))throw new Error('Profiling measurements incomplete; no allocation published');
      const rows=lines(join(directory,'steps.jsonl'));
      for(const caseId of job.caseIds){const task=map.get(caseId);sources.push(sourceRef(root,task.path));const found=new Set<string>();
        for(const row of rows.filter(r=>r.taskId===task.data.taskId&&r.graphId&&r.graphId!=='diagnostic')){const capability=row.node?.startsWith('CONTEXT.')?'Context':row.node?.startsWith('INFER.')?'Infer':row.node?.startsWith('MEMORY.')?'Memory':row.node?.startsWith('INTERACTION.')?'Interaction':null;
          if(!capability)throw new Error('Unknown profiling node');if(!Number.isFinite(row.workMs)||row.workMs<0||row.success===false)throw new Error('Invalid/failed profiling measurement');
          const net=reconnect(row);
          if(isSample(row)){if(net.workExcludingConnectRetryMs===null)throw new Error('Missing or invalid profiling connectRetries/connectRetryWaitMs/workMs: '+join(directory,'steps.jsonl')+' task '+task.data.taskId);connectRetries+=net.connectRetries;connectRetryWaitMs+=net.connectRetryWaitMs;}
          A[capability]+=net.workExcludingConnectRetryMs!;found.add(capability);
        }if(found.size!==4)throw new Error('Profiling capability measurements missing');
      }sources.push(sourceRef(root,join(directory,'steps.jsonl')));
    }
    byCategory[category]={A,connectRetries,connectRetryWaitMs,...optimize(A),sources};
  }
  const result={version:1,status:'complete',sourceRunId:plan.runId,planHash:plan.hash,sourceMode:plan.stage.egress.mode,measurement:'steps.jsonl workMs = ended.ns-started.ns; SAMPLE subtracts connectRetryWaitMs exactly once and requires connectRetries/connectRetryWaitMs; other nodes unchanged; Worker queue and diagnostic nodes excluded; category connectRetryWaitMs reports total deducted',tieBreak:'lexicographically smallest [Context,Infer,Interaction,Memory]',byCategory};json(output,result,true);return result;
}
