import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {env,json,read,lines,sleep,digest,alive} from '../src/ts/scheduler/io.ts';
import {createModelClient} from '../src/ts/model-client.ts';
import {Ledger} from '../src/ts/egress/ledger.ts';
if(!process.argv.includes('--scheduler-authorized'))throw Error('This probe requires the explicit scheduler/Docker handoff before execution');
const output=resolve(process.argv[2]),corrupt=process.argv.includes('--corrupt-race'),before=process.argv.includes('--before');fs.mkdirSync(output,{recursive:true});
const hook=(o:any)=>{const url=pathToFileURL(resolve('tests/t8c-fix1-recovery-hook.mjs'));url.searchParams.set('o',JSON.stringify(o));return url.href;};
async function until(predicate:()=>any,why:string,ms=30000){const end=Date.now()+ms;for(;;){if(await predicate())return;if(Date.now()>end)throw Error('Timed out '+why);await sleep(10);}}
function child(root:string,label:string,args:string[],imports:string[]=[]){
  const path=join(root,label+'.log'),fd=fs.openSync(path,'wx'),command=['--experimental-transform-types',...args];fs.writeSync(fd,'COMMAND: node '+command.join(' ')+'\n');
  const proc=spawn(process.execPath,command,{windowsHide:true,env:env(join(root,'guards',label),imports),stdio:['ignore',fd,fd]});
  const done=new Promise<number|null>((yes,no)=>{proc.once('error',no);proc.once('close',code=>{fs.writeSync(fd,'\nEXIT_CODE='+code+'\n');fs.closeSync(fd);yes(code);});});return {proc,done};
}
const results=[];
for(let i=1;i<=5;i++){
  const root=join(output,'case-'+i);fs.mkdirSync(root);const s=stage('t8cf1-race-'+(before?'before':'after')+'-'+i,['multi_turn_base_0']);freeze(s,root);
  const entered=join(root,'entered'),shell=child(root,'shell',['src/ts/scheduler/egress-shell.ts',root],[hook({role:'transport',entered})]);let a:ReturnType<typeof child>|undefined,b:ReturnType<typeof child>|undefined;
  try{
    await until(()=>fs.existsSync(join(root,'scheduler/egress/control.json'))&&fs.existsSync(join(root,'egress/status.json')),'shell ready');
    const request=createModelClient(read(join(root,'egress/status.json')).url).invoke({messages:[{role:'user',content:'Independent isolated recovery race'}],actions:[],model:{model:s.egress.settings.model.model},metadata:{configId:'direct-c1',taskId:s.runId+'/direct-c1/r1/multi_turn_base_0',caseId:'multi_turn_base_0',turn:1,step:1}} as any,{} as any).catch(error=>String(error));
    await until(()=>fs.existsSync(entered),'reservation barrier');assert.equal(lines(join(root,'egress/ledger.jsonl')).filter(r=>r.kind==='reserve').length,1);
    shell.proc.kill('SIGKILL');await shell.done;await request;const prefix=fs.readFileSync(join(root,'egress/ledger.jsonl'));await sleep(5100);
    const readyA=join(root,'readyA'),readyB=join(root,'readyB'),releaseA=join(root,'releaseA'),releaseB=join(root,'releaseB'),baseline=before?['--before']:[];
    a=child(root,'A',['tests/t8c-fix1-recovery-child.ts',root,'A',...baseline],[hook({role:'A',readyA,releaseA})]);await until(()=>fs.existsSync(readyA),'A checked old lock');
    b=child(root,'B',['tests/t8c-fix1-recovery-child.ts',root,'B',...baseline],[hook({role:'B',readyB,releaseB,afterOpen:corrupt})]);
    await until(()=>fs.existsSync(readyB)||b!.proc.exitCode!==null,'B owns lock or explicitly refused');
    let owner:any=null;if(fs.existsSync(readyB)){owner=read(join(root,'egress/gateway.lock'));assert.equal(owner.pid,b.proc.pid);}
    fs.writeFileSync(releaseA,'A may resume');const aCode=await a.done;fs.writeFileSync(releaseB,'B may resume');const bCode=await b.done;
    const ar=read(join(root,'recover-A.json')),br=read(join(root,'recover-B.json'));let audit:any;
    try{const ledger=await new Ledger(join(root,'egress/ledger.jsonl'),s.egress.settings,s.egress.mode,digest(s.egress),s.egress.dispatchPolicy.maxInFlight).open(true,true);audit={ok:true,snapshot:ledger.snapshot()};}catch(error){audit={ok:false,error:String(error)};}
    assert(fs.readFileSync(join(root,'egress/ledger.jsonl')).subarray(0,prefix.length).equals(prefix));
    if(before){assert.equal(ar.ok,true);assert.equal(br.ok,false);assert.match(br.error,/ENOENT/);if(corrupt)assert.equal(audit.ok,false,'the before-code corruption must reproduce');}
    else{assert.equal(ar.ok,true);assert.equal(br.ok,false);assert.match(br.error,/Another scheduler is active|Scheduler lock acquisition busy/);assert.equal(audit.ok,true);assert.equal(lines(join(root,'egress/ledger.jsonl')).filter(r=>r.kind==='retain_failed').length,1);}
    const result={iteration:i,before,corrupt,aCode,bCode,owner,ar,br,audit,ledgerPrefixPreserved:true};results.push(result);json(join(root,'race-proof.json'),result,true);json(join(output,'results.json'),results);console.log(JSON.stringify({iteration:i,before,corrupt,aCode,bCode,ledgerReadable:audit.ok,prefixPreserved:true}));
  }finally{
    // Only our own exact child processes; never terminate a scheduler from another session.
    for(const c of [a,b,shell])if(c?.proc.pid&&alive(c.proc.pid)){c.proc.kill('SIGKILL');await c.done;}
  }
}
assert.equal(results.length,5);
