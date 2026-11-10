// T9 segment B test tools: a local HTTPS fake API, fake keys, and the real t8a.ts command line.
// The fake key exists only in the key file and in this process; nothing here prints or saves it.
import {createServer} from 'node:https';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {read,json,env,files,lines,sleep,ROOT} from '../src/ts/scheduler/io.ts';
import {matrix,type StageConfig,type Plan} from '../src/ts/scheduler/plan.ts';
import {merged} from '../src/ts/scheduler/records.ts';
import {referenceRoot} from './t8a-helpers.ts';
// T9 C2: T9_LIVE_SCRATCH lets another copy keep its runs in its own scratch; the default is unchanged.
export const scratchRoot=process.env.T9_LIVE_SCRATCH??'F:/Academic/Ditto/experiments/sec1/_tmp/scratch/t9-b';
export const keysRoot=join(scratchRoot,'keys');
export const targetedSplit=process.env.WEB_B_TEST_TARGETED_SPLIT??join(scratchRoot,'synthetic-web-targeted-split.json');
const openssl='C:/Program Files/Git/mingw64/bin/openssl.exe';
/** A throwaway CA and a server certificate for 127.0.0.1 and localhost, generated per test run. */
export function certificates(directory:string,opensslPath=openssl){
  mkdirSync(directory,{recursive:true});const p=(n:string)=>join(directory,n),run=(args:string[])=>execFileSync(opensslPath,args,{stdio:'pipe',windowsHide:true,cwd:directory});
  if(!existsSync(p('server.crt'))){
    run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',p('ca.key'),'-out',p('ca.crt'),'-days','2','-subj','/CN=t9 fake api ca','-addext','basicConstraints=critical,CA:TRUE']);
    run(['req','-newkey','rsa:2048','-nodes','-keyout',p('server.key'),'-out',p('server.csr'),'-subj','/CN=localhost']);
    writeFileSync(p('ext.cnf'),'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n');
    run(['x509','-req','-in',p('server.csr'),'-CA',p('ca.crt'),'-CAkey',p('ca.key'),'-CAcreateserial','-days','2','-out',p('server.crt'),'-extfile',p('ext.cnf')]);
  }
  return {ca:p('ca.crt'),cert:p('server.crt'),key:p('server.key')};
}
/** The key file holds three names; only the two the configuration names may ever be used. */
export function fakeKeys(name:string,baseUrl:string){
  const directory=join(keysRoot,name);mkdirSync(directory,{recursive:true});const file=join(directory,'fake-live.keys');
  const apiKey='FAKEKEY-'+randomBytes(32).toString('hex'),other='FAKEOTHER-'+randomBytes(32).toString('hex');
  writeFileSync(file,`# fake test keys\nBFCL_BASE_URL=${baseUrl}\nBFCL_API_KEY=${apiKey}\nOTHER_SECRET=${other}\n`);return {file,apiKey,directory};
}
export interface Call {n:number;body:Buffer;text:string;parsed:any;url:string;authorized:boolean;at:number;res:any}
type Respond=(status:number,payload:any,headers?:Record<string,string>)=>void;
export type Behavior=(call:Call,respond:Respond,api:FakeApi)=>Promise<boolean|void>|boolean|void;
export class FakeApi {
  received=0;active=0;peak=0;mismatches=0;unauthorized=0;paths=new Set<string>();times:number[]=[];
  behavior?:Behavior;leak=false;delayMs=0;usage?:(usage:any)=>any;bodies:string[]=[];
  private map=new Map<string,any>();private held=new Set<()=>void>();private sockets=new Set<any>();private server:any;port=0;
  constructor(readonly apiKey:()=>string){}
  /** Old requests by the sha256 of their exact JSON bytes. */
  load(caseIds:string[]){
    const source=join(referenceRoot,'runs/multiturn-full800-001'),index=read(join(ROOT,'runs/offline/replay-index/index.json'));
    for(const [position,entry] of Object.entries<any>(index.records)){
      if(!caseIds.includes(position.split('/')[0]))continue;
      const old=read(join(source,'model-records',entry.file));
      this.map.set(createHash('sha256').update(JSON.stringify(old.requestBody)).digest('hex'),old.rawResponse);
    }
    return this.map.size;
  }
  async start(tls:{cert:string;key:string}){
    this.server=createServer({cert:readFileSync(tls.cert),key:readFileSync(tls.key)},(req,res)=>{void this.handle(req,res);});
    this.server.on('connection',(s:any)=>{this.sockets.add(s);s.once('close',()=>this.sockets.delete(s));});
    await new Promise<void>(yes=>this.server.listen(0,'127.0.0.1',yes));this.port=this.server.address().port;return this;
  }
  get url(){return 'https://127.0.0.1:'+this.port;}
  private async handle(req:any,res:any){
    const chunks:Buffer[]=[];for await(const b of req)chunks.push(b);
    const body=Buffer.concat(chunks),text=body.toString('utf8'),n=++this.received;this.active++;this.peak=Math.max(this.peak,this.active);this.times.push(Date.now());this.paths.add(req.url);
    const authorized=req.headers.authorization==='Bearer '+this.apiKey();if(!authorized)this.unauthorized++;
    let done=false;const finish=()=>{if(!done){done=true;this.active--;}};res.once('close',finish);
    const respond:Respond=(status,payload,headers={})=>{if(res.destroyed||res.headersSent)return;res.writeHead(status,{'content-type':'application/json',...headers});res.end(typeof payload==='string'?payload:JSON.stringify(payload));finish();};
    let parsed:any=null;try{parsed=JSON.parse(text);}catch{}
    const call={n,body,text,parsed,url:req.url,authorized,at:Date.now(),res};
    if(this.delayMs)await sleep(this.delayMs);
    if(this.behavior&&await this.behavior(call,respond,this))return;
    this.replay(call,respond);
  }
  /** Default behaviour: the old raw response for a byte-identical request, or a loud 400. */
  replay(call:Call,respond:Respond){
    const raw=this.map.get(createHash('sha256').update(call.body).digest('hex'));
    if(!raw){this.mismatches++;respond(400,{error:{message:'t9 fake api: request body matches no old record'}});return;}
    const reply=structuredClone(raw);if(this.usage)reply.usage=this.usage(reply.usage);
    if(this.leak){reply.debug_echo='key='+this.apiKey();reply.debug_authorization='Authorization: Bearer '+this.apiKey();}
    respond(200,reply,this.leak?{location:'https://example.invalid/next?token='+this.apiKey()}:{});
  }
  /** Keeps a request open until released; closing the connection also ends it. */
  hold(){return new Promise<void>(yes=>{this.held.add(yes);});}
  release(){for(const open of this.held)open();this.held.clear();}
  async stop(){this.release();for(const s of this.sockets)s.destroy();await new Promise<void>(yes=>this.server.close(()=>yes()));}
}
export const leakyError=(key:string)=>({error:{code:'bad_'+key,type:'Authorization: Bearer '+key,message:'rejected key '+key+' header Authorization: Bearer '+key+' at https://example.invalid/?k='+encodeURIComponent(key)}});
/** A small real stage with every limit filled by a harmless test number. */
export function liveStage(runId:string,tag:string,configIds:string[],caseIds:string[],change:(s:StageConfig)=>void=()=>{}):StageConfig{
  const s=read<StageConfig>(join(ROOT,'config/stages/live-pilot.json')),all=matrix();
  s.runId=runId;s.stage='t9-live';s.launcher={kind:'docker',tag,runtime:{clockTicks:100,pageBytes:4096}};if(all.some(c=>configIds.includes(c.id)&&c.copies==='profile'))s.targetedSplit=targetedSplit;else delete s.targetedSplit;
  s.configs=configIds.map(id=>all.find(c=>c.id===id)!);s.batches=[{id:'live',configs:configIds,caseIds}];s.blockSize=50;
  s.stall={idleMs:120000,stopGraceMs:5000,pollMs:200};s.hostSampleMs=1000;
  s.prices={source:'t9 test numbers, not billing',date:'2026-11-07',valley:{cachedInput:0.02,uncachedInput:1,output:4},peak:{cachedInput:0.04,uncachedInput:2,output:8}};
  const e=s.egress;e.settings.model.referencePrice={inputPerMillion:0.3,outputPerMillion:1.2};
  e.settings.budget={referenceUsd:2000,maxRequests:100000,referenceCny:1000,peakCnyPerMillion:{cachedInput:0.04,uncachedInput:2,output:8}};
  Object.assign(e,{searchMaxRequests:1000,searchCny:5,searchDispatch:{maxInFlight:4,requestsPerMinute:60}});
  change(s);return s;
}
export interface Cli {code:number|null;stdout:string;stderr:string}
/** The real command line. The scheduler carries the key directory as a forbidden path. */
export function t8a(args:string[],aux:string,label:string,extra:{ca?:string;forge?:any}={}):{done:Promise<Cli>;pid:number|undefined}{
  mkdirSync(aux,{recursive:true});const hook=pathToFileURL(join(ROOT,'tests/t9-live-hook.mjs')).href;
  const out=join(aux,label+'.log');
  const child=spawn(process.execPath,['--experimental-transform-types','scripts/t8a.ts',...args],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...env(join(aux,'guards',label),[hook]),OFFLINE_GUARD_EXTRA_FORBIDDEN:JSON.stringify([keysRoot]),...(extra.ca?{T9_CA_FILE:extra.ca}:{}),...(extra.forge?{T9_FORGE:JSON.stringify(extra.forge)}:{})}});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const done=new Promise<Cli>((yes,no)=>{child.once('error',no);child.once('close',code=>{writeFileSync(out,JSON.stringify({args,code,stdout,stderr},null,1));yes({code,stdout,stderr});});});
  return {done,pid:child.pid};
}
export const liveArgs=(runRoot:string,keyFile:string,hash:string,note='t9 fake api test run')=>['run','--root',runRoot,'--live','--key-file',keyFile,'--live-authorization',`live:${hash} ${note}`];
export async function freezeLive(stage:StageConfig,runRoot:string,aux:string){
  const stageFile=join(aux,'stage.json');mkdirSync(aux,{recursive:true});json(stageFile,stage);
  const {code,stdout,stderr}=await t8a(['plan','--stage',stageFile,'--root',runRoot],aux,'plan').done;
  if(code!==0)throw Error('freeze failed: '+stderr);return read<Plan>(join(runRoot,'plan.json'));
}
export async function until(predicate:()=>boolean|Promise<boolean>,message:string,limit=180000){for(const end=Date.now()+limit;;){if(await predicate())return;if(Date.now()>end)throw Error('Timed out: '+message);await sleep(50);}}
/** What compare.py reads: merged task files plus the requests the egress actually sent. */
export function comparisonInput(root:string,output:string){
  const plan=read<Plan>(join(root,'plan.json'));mkdirSync(join(output,'egress'),{recursive:true});const requests:string[]=[],index=read(join(ROOT,'runs/offline/replay-index/index.json')).records;
  for(const job of plan.jobs)for(const unit of job.units)for(const row of merged(root,job,unit.configId).values())if(row.kind==='tasks'){
    const dst=join(output,'configs',unit.configId,'tasks');mkdirSync(dst,{recursive:true});writeFileSync(join(dst,row.data.caseId+'.json'),readFileSync(row.path));
    for(const step of row.data.modelSteps){const rid=step.output.message.metadata.budgetReceipt.id,record=read(join(root,'egress','model-records',rid+'.json'));
      requests.push(JSON.stringify({configId:unit.configId,taskId:record.taskId,caseId:record.caseId,turn:record.logicalTurn,step:record.logicalStep,position:`${record.caseId}/${record.logicalTurn}/${record.logicalStep}`,source:index[`${record.caseId}/${record.logicalTurn}/${record.logicalStep}`],requestBody:record.requestBody,differences:[]}));}
  }
  writeFileSync(join(output,'egress','requests.jsonl'),requests.join('\n')+'\n');return requests.length;
}
export function ledgerRows(root:string){const rows=lines(join(root,'egress','ledger.jsonl'));const count=(k:string)=>rows.filter(r=>r.kind===k).length;return {rows,reserved:count('reserve'),settled:count('settle'),retained:count('retain_failed'),uncertain:count('uncertain')};}
export {files,read,json,env,lines,sleep,ROOT,closeSync,openSync};
