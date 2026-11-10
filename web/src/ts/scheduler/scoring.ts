import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {existsSync,mkdirSync,readdirSync} from 'node:fs';
import {ROOT,env,read,json,maybe,now,files} from './io.ts';
import {merged,sourceRef} from './records.ts';
import type {Plan,PlannedJob} from './plan.ts';
export interface Scorer {score(input:string,output:string,timeoutMs:number):Promise<{exitCode:number|null;timedOut:boolean;stdout:string;stderr:string}>}
export class HostScorer implements Scorer {
  constructor(readonly python:string,readonly report:string){}
  async score(input:string,output:string,timeoutMs:number){return new Promise<{exitCode:number|null;timedOut:boolean;stdout:string;stderr:string}>((yes,no)=>{
    const child=spawn(this.python,['-B','-X','utf8',join(ROOT,'src/python/score.py'),'--input',input,'--output',output],{cwd:ROOT,env:env(this.report),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    child.once('error',e=>{clearTimeout(timer);no(e);});child.once('close',exitCode=>{clearTimeout(timer);yes({exitCode,timedOut,stdout,stderr});});
  });}
}
export async function scoreJob(root:string,plan:Plan,job:PlannedJob,scorer:Scorer,force=false){
  const queue=job.units.flatMap(u=>[...merged(root,job,u.configId).values()].filter(r=>r.kind==='tasks').map(r=>({...r,cid:u.configId})));let index=0;
  await Promise.all(Array.from({length:plan.stage.score.concurrency},async()=>{while(index<queue.length){const r=queue[index++],base=join(root,'scores',job.key,r.cid,r.data.caseId),source=sourceRef(root,r.path);const previous=files(base).filter(p=>p.endsWith('result.json')).map(p=>read(p));
    if(!force&&previous.some(p=>p.source.sha256===source.sha256))continue;
    mkdirSync(base,{recursive:true});const next=Math.max(0,...readdirSync(base).map(name=>Number(/^score-(\d+)$/.exec(name)?.[1]??0)))+1;
    const directory=join(base,`score-${next}`);mkdirSync(directory);const output=join(directory,'official.json');let processResult:any;
    try{processResult=await scorer.score(r.path,output,plan.stage.score.timeoutMs);}catch(e){processResult={exitCode:null,timedOut:false,stdout:'',stderr:String(e)};}
    let official:any=null;try{official=maybe(output);}catch(error){processResult.outputError=String(error);}
    const status=processResult.exitCode===0&&!processResult.timedOut&&official&&typeof official.valid==='boolean'?'scored':'scoring-failed';
    json(join(directory,'result.json'),{source,at:now(),status,process:processResult,official:status==='scored'?official:null},true);
  }}));
}
export function scoreFor(root:string,job:PlannedJob,cid:string,caseId:string,path:string){const source=sourceRef(root,path);return files(join(root,'scores',job.key,cid,caseId)).filter(p=>p.endsWith('result.json')).map(p=>({number:Number(/score-(\d+)/.exec(p)?.[1]),value:read(p)})).filter(r=>r.value.source.sha256===source.sha256).sort((a,b)=>a.number-b.number).at(-1)?.value;}
