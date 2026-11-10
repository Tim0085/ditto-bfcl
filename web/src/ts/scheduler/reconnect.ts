// Only SAMPLE can reconnect. Missing SAMPLE fields are unknown, never zero.
export const isSample=(row:any)=>row.node==='INFER.REASONING.SAMPLE';
export function reconnect(row:any){
 const count=Number.isInteger(row.connectRetries)&&row.connectRetries>=0?row.connectRetries:null;
 const wait=typeof row.connectRetryWaitMs==='number'&&Number.isFinite(row.connectRetryWaitMs)&&row.connectRetryWaitMs>=0?row.connectRetryWaitMs:null;
 const work=typeof row.workMs==='number'&&Number.isFinite(row.workMs)&&row.workMs>=0?row.workMs:null;
 const valid=count!==null&&wait!==null&&work!==null&&wait<=work;
 return {connectRetries:isSample(row)?valid?count:null:row.connectRetries??null,connectRetryWaitMs:isSample(row)?valid?wait:null:row.connectRetryWaitMs??null,
   workExcludingConnectRetryMs:!isSample(row)?work:count===null||wait===null||work===null||wait>work?null:work-wait};
}
export function reconnectSummary(raw:any[],complete:boolean){
 const samples=raw.filter(isSample),missing=raw.flatMap(reconnectMissing);
 if(!complete)missing.push('connectRetries/connectRetryWaitMs: step recording incomplete');
 const valid=complete&&!missing.length;
 return {connectRetries:valid?samples.reduce((n,r)=>n+r.connectRetries,0):null,connectRetryWaitMs:valid?samples.reduce((n,r)=>n+r.connectRetryWaitMs,0):null,reconnectMissing:missing};
}
export function reconnectMissing(row:any,index:number){
 if(!isSample(row))return [];
 const where=`step ${index+1} ${row.invocationId??row.taskId??'unknown'} (SAMPLE)`;
 const out:string[]=[];
 if(!Number.isInteger(row.connectRetries)||row.connectRetries<0)out.push(`connectRetries: ${where}: nonnegative integer required`);
 const wait=row.connectRetryWaitMs,work=row.workMs;
 if(typeof wait!=='number'||!Number.isFinite(wait)||wait<0)out.push(`connectRetryWaitMs: ${where}: nonnegative finite number required`);
 else if(typeof work!=='number'||!Number.isFinite(work)||work<0||wait>work)out.push(`connectRetryWaitMs: ${where}: wait exceeds workMs or workMs invalid`);
 return out;
}
