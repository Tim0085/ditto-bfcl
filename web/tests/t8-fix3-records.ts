import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {mkdirSync,existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {json,maybe,read,sleep,env,files} from '../src/ts/scheduler/io.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {stage} from './t8a-helpers.ts';
const root=resolve(process.argv[2]);mkdirSync(root,{recursive:true});
async function until(test:()=>boolean){const end=Date.now()+60000;while(!test()){assert(Date.now()<end,'barrier timeout');await sleep(10);}}
function child(mode:string,target:string,phase?:string){const args=['--experimental-transform-types','tests/t8-fix3-child.mjs',mode,target,...phase?[phase]:[]];const p=spawn(process.execPath,args,{env:env(join(root,'guards')),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const done=new Promise<number|null>((yes,no)=>{p.on('error',no);p.on('close',code=>{json(join(root,'child-'+p.pid+'.json'),{args,code,stdout,stderr});yes(code);});});return {p,done};}
if(!process.argv.includes('--stop-only')){
for(const name of ['start-permit.json','exit.json','collected.json'])for(let i=0;i<3;i++){
 const target=join(root,name+i,name);mkdirSync(join(root,name+i));const c=child('write',target);let reads=0;
 while(c.p.exitCode===null){const v=maybe(target);if(v)assert.equal(v.payload.length,10000);reads++;await sleep(2);}assert.equal(await c.done,0);assert(reads>0);console.log(JSON.stringify({window:name,iteration:i,reads,result:'PASS'}));
}
for(let i=0;i<20;i++){const p=join(root,'race-'+i+'.json'),a=child('write',p),b=child('write',p);assert.deepEqual((await Promise.all([a.done,b.done])).sort(),[0,2]);assert.equal(read(p).payload.length,10000);console.log('exclusive race PASS',i);}
for(const phase of ['partial','before-link']){const p=join(root,phase+'.json'),c=child('write',p,phase);await until(()=>existsSync(p+'.barrier')&&(phase!=='before-link'||readFileSync(p+'.barrier','utf8')==='complete'));c.p.kill();await c.done;assert.equal(maybe(p),undefined);assert(readdirSync(root).some(n=>n.startsWith(phase+'.json.pending-')));console.log('crash barrier PASS',phase);}
const damaged=join(root,'bad.json');writeFileSync(damaged,'{"broken":');assert.throws(()=>maybe(damaged),e=>e instanceof SyntaxError&&e.message.includes(damaged));
}
for(let i=0;i<5;i++){
 const run=join(root,'stop-'+i),s=stage('t8fix3-stop-'+i);freeze(s,run);const launcher=new LocalProcessLauncher(join(run,'registry'));let c:ReturnType<typeof child>|undefined;let release:Promise<void>|undefined;
 const fake={kind:'local-process' as const,toUnitView:(spec:any)=>spec.block,list:async()=>[],adopt:async()=>undefined,start:async(spec:any)=>{
   json(join(spec.logDir,'spec.json'),spec);c=child('control',join(spec.logDir,'spec.json'));await until(()=>existsSync(join(spec.logDir,'control.json'))&&existsSync(join(spec.logDir,'exiting-started')));
   json(join(run,'egress','stopped.json'),{reason:'test egress stop'});
   release=(async()=>{await until(()=>existsSync(join(spec.logDir,'ack-dropped')));assert.equal(c!.p.exitCode,null);assert.equal(maybe(join(spec.logDir,'exit.json')),undefined);writeFileSync(join(spec.logDir,'release-exit'),'go');})();
   return (launcher as any).unit(spec);
 }};
 try{const report=await runSchedule(run,fake);await release;assert.equal(report.reason,'egress-stop');assert.equal(files(join(run,'blocks')).filter(p=>p.endsWith('collected.json')).length,1);assert.equal(await c!.done,0);console.log('deterministic stop / collected / egress-stop PASS',i);}finally{if(c&&c.p.exitCode===null){c.p.kill();await c.done;}}
}
for(const method of ['stop','kill'] as const){const dir=join(root,'live-broken-'+method),spec={runId:'broken',unitId:'broken',logDir:dir,outputRoot:dir,guardReportDir:join(dir,'guards'),block:{configId:'broken'}};json(join(dir,'spec.json'),spec);const c=child('control',join(dir,'spec.json'),'broken');try{await until(()=>existsSync(join(dir,'closed')));const unit=(new LocalProcessLauncher(join(dir,'registry')) as any).unit(spec);const start=Date.now();await assert.rejects(unit[method]('test'),/ECONNREFUSED|Control/);assert(Date.now()-start>=4900);assert.equal(c.p.exitCode,null);console.log('live control fault preserved PASS',method,Date.now()-start);}finally{c.p.kill();await c.done;}}
console.log('PASS M1/M2 deterministic records and stop probes');
