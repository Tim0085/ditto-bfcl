import {readFileSync,existsSync,copyFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {json} from './io.ts';
import type {Ledger} from '../egress/ledger.ts';

// Run under gateway.lock, before any ledger mutation or stopped-marker removal.
export function reconcileRate(directory:string,ledger:Pick<Ledger,'reservations'|'settlements'>,archive:string,rateName='rate.jsonl'){
 const path=join(directory,rateName),original=existsSync(path)?readFileSync(path):Buffer.alloc(0);
 const newline=original.lastIndexOf(10),partial=original.length>0&&newline!==original.length-1;
 const prefix=partial?original.subarray(0,newline+1):original,tail=partial?original.subarray(newline+1).toString('utf8'):'';
 const reservations=[...ledger.reservations.values()],rows:any[]=[];
 const fail=(line:number,why:string):never=>{throw Error(`${rateName} line ${line}: ${why}`);};
 for(const [index,line] of prefix.toString('utf8').split('\n').entries()){
  if(!line)continue;
  let row:any;try{row=JSON.parse(line);}catch{fail(index+1,'invalid complete JSON row');}
  const expected=reservations[rows.length];
  if(!expected)fail(index+1,`extra ID ${row?.id}; no ledger reservation`);
  if(row?.id!==expected.id)fail(index+1,`ID ${String(row?.id)} != ledger ID ${expected.id}`);
  if(rateName!=='rate.jsonl'&&row.configId!==expected.configId)fail(index+1,`ID ${expected.id}: configuration mismatch`);
  if(!Number.isSafeInteger(row.at)||row.at<0)fail(index+1,`ID ${expected.id}: invalid at`);
  rows.push(row);
 }
 if(rows.length===reservations.length&&!partial)return {action:'unchanged'};
 const next=reservations[rows.length],line=prefix.toString('utf8').split('\n').length;
 if(reservations.length-rows.length!==1)fail(line,`expected exactly one final reservation; rate=${rows.length}, ledger=${reservations.length}, next ID ${next?.id??'none'}`);
 // A missing/partial final start cannot already have a settlement. Retained
 // unknown requests are allowed so retrying an interrupted recovery is safe.
 if(ledger.settlements.has(next.id))fail(line,`ID ${next.id} already settled; missing start is not a recoverable admission gap`);
 let tailAt=0,timestampUpperBound=false;
 if(partial){
  // Verify every byte as a prefix of the actual limiter serialization. A
  // truncated ID/config/timestamp cannot hide a different historical record.
  const lead=JSON.stringify({configId:next.configId,id:next.id}).slice(0,-1)+',"at":';
  if(!lead.startsWith(tail)&&!tail.startsWith(lead))fail(line,`partial row does not match final ledger ID ${next.id}`);
  if(tail.endsWith('}')){
   let row:any;try{row=JSON.parse(tail);}catch{fail(line,`invalid final JSON for ID ${next.id}`);}
   if(!Number.isSafeInteger(row.at)||row.at<0||JSON.stringify({configId:next.configId,id:next.id,at:row.at})!==tail)fail(line,`invalid final ID/config/at for ledger ID ${next.id}`);
   tailAt=row.at;
  }else{
   if(tail.startsWith(lead)){
    const digits=tail.slice(lead.length);
    if(digits&&(!/^(0|[1-9]\d*)$/.test(digits)||!Number.isSafeInteger(Number(digits))))fail(line,`partial at invalid for ID ${next.id}`);
   }
   // The missing digits have no provable wall-clock value, especially after
   // clock rollback. Use the valid numeric upper bound: the unchanged limiter
   // treats future history as an anomaly and cools down a full minute.
   tailAt=Number.MAX_SAFE_INTEGER;timestampUpperBound=true;
  }
 }
 // Reserve has no timestamp. Recovery time is later than the possible send;
 // max also avoids making history less conservative after wall-clock rollback.
 const at=rows.reduce((latest,r)=>Math.max(latest,r.at),Math.max(Date.now(),tailAt));
 const record={configId:next.configId,id:next.id,at,recovered:true,recoveryReason:partial?'partial-final-rate-row':'missing-final-rate-row',...(timestampUpperBound?{timestampUpperBound:true}:{})};
 if(existsSync(path))copyFileSync(path,join(archive,rateName+'.original'),2);
 json(join(archive,rateName.replace(/\.jsonl$/,'')+'-reconciliation.json'),{action:'replace-final-start',line,id:next.id,record,originalBytes:original.length,originalAbsent:!existsSync(path),atRule:'missing row: max(recovery wall clock, complete historical at); complete tail JSON: also keep its at; truncated timestamp: MAX_SAFE_INTEGER upper bound triggers unchanged limiter 60000ms cooldown'},true);
 const temp=path+'.pending-'+randomUUID();
 try{writeFileSync(temp,Buffer.concat([prefix,Buffer.from(JSON.stringify(record)+'\n')]),{flag:'wx',flush:true});renameSync(temp,path);}
 finally{if(existsSync(temp))unlinkSync(temp);}
 return {action:record.recoveryReason,line,id:next.id,at};
}
