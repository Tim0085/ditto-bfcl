import {join} from 'node:path';
import {jsonRows} from './export-stream.ts';
// T9 C1 (task book 5.3a): same result as the pre-T9 graphTimes, without its two quadratic scans.
// Pre-T9: for each started event, the first later-or-earlier event of the same task and iteration
// whose status is not "started" (file order), and the step rows of that task and graph whose
// sent..returned lies inside the event window, sorted by sent (stable, file order on ties).
// Here both lookups are indexed once; rows per task+graph are pre-sorted by sent and found by
// binary search, so the cost is about (events + rows) log rows.
// T9 C3: the indexes are two-level Maps keyed by the raw values. A Map tells keys apart the way the pre-T9 === tests did
// (for JSON data; only NaN differs, and JSON has no NaN), so null and undefined, 1 and "1", stay different keys; the
// earlier JSON.stringify keys merged null with undefined. An event without an event object is never an end here (pre-T9
// threw on it as soon as its task matched).
const ns=(p:any)=>p?.ns?BigInt(p.ns):null;
type Index<T>=Map<unknown,Map<unknown,T>>;
const lookup=<T>(index:Index<T>,a:unknown,b:unknown)=>index.get(a)?.get(b);
function slot<T>(index:Index<T>,a:unknown,b:unknown,make:()=>T){let inner=index.get(a);if(!inner)index.set(a,inner=new Map());if(!inner.has(b))inner.set(b,make());return inner.get(b)!;}
export function graphTimesFromRows(events:any[],raw:any[]){
 const times=new Map<string,number>(),ends:Index<any>=new Map();
 for(const e of events)if(e.event!=null&&e.event.status!=='started')slot(ends,e.taskId,e.event.iteration,()=>e);
 const byGraph:Index<{sent:bigint;returned:bigint;index:number;row:any}[]>=new Map();
 for(const [index,r] of raw.entries()){if(!r.sent?.ns||!r.returned?.ns)continue;slot(byGraph,r.taskId,r.graphId,()=>[]).push({sent:BigInt(r.sent.ns),returned:BigInt(r.returned.ns),index,row:r});}
 // A row returned before it was sent (damaged clock) could still pass the old window test after
 // sent > finish, so such lists are scanned to the end; ordinary lists stop at sent > finish.
 const inverted=new Set<unknown>();
 for(const inner of byGraph.values())for(const list of inner.values()){list.sort((a,b)=>a.sent<b.sent?-1:a.sent>b.sent?1:a.index-b.index);if(list.some(x=>x.returned<x.sent))inverted.add(list);}
 for(const start of events){if(start.event?.status!=='started')continue;const end=lookup(ends,start.taskId,start.event.iteration);if(!end)continue;
  const begin=ns(start.at)!,finish=ns(end.at)!,list=lookup(byGraph,start.taskId,start.event.graphId)??[],scanAll=inverted.has(list);
  let lo=0,hi=list.length;while(lo<hi){const mid=(lo+hi)>>1;if(list[mid].sent<begin)lo=mid+1;else hi=mid;}
  const rows:any[]=[];for(let i=lo;i<list.length&&(scanAll||list[i].sent<=finish);i++)if(list[i].returned<=finish)rows.push(list[i]);
  if(rows.length!==start.event.nodes.length)continue;let cursor=begin;
  for(const [i,item] of rows.entries()){const before=item.sent-cursor,tail=i===rows.length-1?finish-item.returned:0n;if(before<0n||tail<0n)continue;times.set(item.row.invocationId,Number(before+tail)/1e6);cursor=item.returned;}
 }return times;
}
export function graphTimes(directory:string,raw:any[]){return graphTimesFromRows(Array.from(jsonRows(join(directory,'graphs.jsonl'))).filter(e=>!e.malformed),raw);}
