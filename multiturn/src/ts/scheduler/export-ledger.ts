import {join} from 'node:path';
import {existsSync} from 'node:fs';
import type {Plan} from './plan.ts';
import {jsonRows} from './export-stream.ts';
type Bucket={requests:number;settled:number;cached:number|null;input:number|null;output:number|null;unknown:number;held:number;
  reasoning:number|null;settledMicroUsd:number;heldMicroCny:number;confirmedFree:number;confirmedCharged:number;confirmedChargedCny:number};
const empty=():Bucket=>({requests:0,settled:0,cached:0,input:0,output:0,unknown:0,held:0,reasoning:0,settledMicroUsd:0,heldMicroCny:0,confirmedFree:0,confirmedCharged:0,confirmedChargedCny:0});
const add=(a:number|null,b:any)=>a!==null&&typeof b==='number'&&Number.isFinite(b)?a+b:null;
export type FeeConfirmation={requestId:string;conclusion:'not-charged'|'charged';chargedCny:number|null;at:string;line:number};
/** T9 C1 #44: scheduler/fee-confirmations.jsonl is append-only and written by scripts/confirm-fee.ts; the latest valid line per request wins. */
export function feeConfirmations(root:string){
  const path=join(root,'scheduler','fee-confirmations.jsonl'),byId=new Map<string,FeeConfirmation>(),invalid:number[]=[];let line=0;
  for(const r of jsonRows(path)){line++;
    const ok=r&&!r.malformed&&r.kind==='fee-confirmation'&&typeof r.requestId==='string'&&r.requestId&&typeof r.userText==='string'&&r.userText.trim()&&typeof r.authorization==='string'&&r.authorization.trim()
      &&(r.conclusion==='not-charged'&&(r.chargedCny===null||r.chargedCny===undefined)||r.conclusion==='charged'&&typeof r.chargedCny==='number'&&Number.isFinite(r.chargedCny)&&r.chargedCny>=0);
    if(!ok){invalid.push(line);continue;}
    byId.set(r.requestId,{requestId:r.requestId,conclusion:r.conclusion,chargedCny:r.conclusion==='charged'?r.chargedCny:null,at:String(r.at??''),line});
  }
  return {path,present:existsSync(path),byId,invalidLines:invalid};
}
/** Settled requests are released immediately. Retained liabilities stay in totals unless the user confirmed the fee. */
export function exportLedger(root:string,plan:Plan,confirmations=feeConfirmations(root).byId){
  const path=join(root,'egress/ledger.jsonl'),buckets=new Map<string,Bucket>(),lookup=new Map<string,{round:number;bucket:Bucket}[]>();
  for(const job of plan.jobs)for(const unit of job.units){const bucket=empty();buckets.set(job.key+'/'+unit.configId,bucket);for(const id of job.caseIds){const key=unit.configId+'/'+id,list=lookup.get(key)??[];list.push({round:job.round,bucket});lookup.set(key,list);}}
  const pending=new Map<string,{microUsd:number;microCny:number;buckets:Bucket[]}>();let first=true,available=false;const applied=new Set<string>();
  const liability=(id:string,reservation:{microUsd:number;microCny:number;buckets:Bucket[]},heldMicroCny:number)=>{const c=confirmations.get(id);if(c)applied.add(id);
    for(const b of reservation.buckets){if(c?.conclusion==='not-charged')b.confirmedFree++;else if(c?.conclusion==='charged'){b.confirmedCharged++;b.confirmedChargedCny+=c.chargedCny!;}else{b.unknown++;b.held+=reservation.microUsd;b.heldMicroCny+=heldMicroCny;}}};
  for(const row of jsonRows(path,true)){
    if(first){available=existsSync(path)&&row?.kind==='header';first=false;}
    if(row.kind==='reserve'){
      if(pending.has(row.id))throw Error('Duplicate pending ledger reservation: '+row.id);
      const own=(lookup.get(row.configId+'/'+row.caseId)??[]).filter(p=>row.taskId?.includes('/r'+p.round+'/')).map(p=>p.bucket);
      for(const b of own)b.requests++;pending.set(row.id,{microUsd:row.microUsd,microCny:typeof row.microCny==='number'?row.microCny:0,buckets:own});
    }else if(row.kind==='settle'||row.kind==='retain_failed'){
      const reservation=pending.get(row.id);if(!reservation)throw Error('Ledger settlement/retention lacks pending reservation: '+row.id);
      if(row.kind==='settle')for(const b of reservation.buckets){b.settled++;b.cached=add(b.cached,row.usage?.cachedInputTokens);b.input=add(b.input,row.usage?.inputTokens);b.output=add(b.output,row.usage?.outputTokens);b.reasoning=add(b.reasoning,row.usage?.reasoningTokens);b.settledMicroUsd+=typeof row.microUsd==='number'?row.microUsd:0;}
      else liability(row.id,reservation,typeof row.heldMicroCny==='number'?row.heldMicroCny:reservation.microCny);
      pending.delete(row.id);
    }
  }
  for(const [id,reservation] of pending)liability(id,reservation,reservation.microCny);
  return {available,buckets,appliedConfirmations:[...applied].sort(),ignoredConfirmations:[...confirmations.keys()].filter(id=>!applied.has(id)).sort()};
}
