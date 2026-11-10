import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdirSync,mkdtempSync,cpSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {read,json,ROOT,env,files,lines} from '../src/ts/scheduler/io.ts';
import {matrix,type StageConfig,type Plan} from '../src/ts/scheduler/plan.ts';
import {merged} from '../src/ts/scheduler/records.ts';
export const scratch=()=>{const base=join(tmpdir(),'t8a-scratch');mkdirSync(base,{recursive:true});return mkdtempSync(join(base,'test-'));};
export const referenceRoot=resolve(process.env.T8A_REFERENCE_ROOT??join(ROOT,'../../bfcl_direct'));
export function stage(runId:string,caseIds=['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11']):StageConfig{
 const s=read<StageConfig>(join(ROOT,'config/stages/profile.json'));s.stage='test';s.runId=runId;s.python='E:/Anaconda3/python.exe';s.egress.backend='replay';s.egress.replay!.source=join(referenceRoot,'runs/multiturn-full800-001');s.stall={idleMs:120000,stopGraceMs:10000,pollMs:100};s.hostSampleMs=2000;s.configs=[matrix().find(c=>c.id==='direct-c1')!];s.batches=[{id:'test',configs:s.configs.map(c=>c.id),caseIds}];return s;
}
export async function command(file:string,args:string[],output:string,options:NodeJS.ProcessEnv={}){const child=spawn(file,args,{cwd:ROOT,env:{...env(join(output,'guards')),...options},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const code=await new Promise<number|null>((yes,no)=>{child.on('error',no);child.on('close',yes);});json(output+'.json',{command:[file,...args],code,stdout,stderr},true);return {code,stdout,stderr};}
export function comparisonView(root:string,output:string){const plan=read<Plan>(join(root,'plan.json'));mkdirSync(join(output,'egress'),{recursive:true});const requests:any[]=[],recordedRequests=lines(join(root,'egress','requests.jsonl'));
  for(const job of plan.jobs)for(const unit of job.units)for(const row of merged(root,job,unit.configId).values())if(row.kind==='tasks'){
    const dst=join(output,'configs',unit.configId,'tasks');mkdirSync(dst,{recursive:true});cpSync(row.path,join(dst,row.data.caseId+'.json'),{errorOnExist:true,force:false});
    for(const step of row.data.modelSteps){const rid=step.output.message.metadata.budgetReceipt.id,record=read(join(root,'egress','model-records',rid+'.json'));const candidates=recordedRequests.filter(r=>r.configId===unit.configId&&r.taskId===record.taskId&&r.turn===record.logicalTurn&&r.step===record.logicalStep&&JSON.stringify(r.requestBody)===JSON.stringify(record.requestBody));const source=candidates.at(-1);if(!source)throw new Error('No matching original egress request');requests.push(source);}
  }
  writeFileSync(join(output,'egress','requests.jsonl'),requests.map(r=>JSON.stringify(r)).join('\n')+'\n',{flag:'wx'});
}
