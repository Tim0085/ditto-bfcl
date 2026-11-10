import {join,resolve} from 'node:path';
import {startEgress} from '../egress/server.ts';
import {read,json,now,log,maybe} from './io.ts';
import {control} from './control.ts';
import {SEARCH_ENDPOINT_PATH} from '../search-endpoint.ts';
const root=resolve(process.argv[2]),config=read(join(root,'plan.json')).stage,liveMode=config.egress.backend==='live'&&config.egress.mode==='live';
if(!liveMode&&(!['fixtures','replay'].includes(config.egress.backend)||config.egress.mode!=='offline-reference'))throw new Error('Only offline egress is authorized');
// T9 B: a real egress runs under the live guard alone. A forged launch was given the offline guard and stops here.
const liveGuard=(globalThis as any)[Symbol.for('ditto.egress.liveGuard')],offlineGuard=(globalThis as any)[Symbol.for('ditto.egress.offlineGuard')];
if(liveMode?!process.argv[3]||!liveGuard||offlineGuard:process.argv[3]||liveGuard)throw new Error('A real egress needs a key file and the live guard alone; an offline egress takes neither');
// T8a fix 6: written before startEgress takes gateway.lock, so a hard kill during startup is still attributable.
json(join(root,'scheduler','egress','pid.json'),{pid:process.pid,at:now()});
const directory=join(root,'egress'),service=await startEgress(config.egress,directory,liveMode?{...config.endpoint,live:true,credentials:liveGuard.readCredentials(config.egress.settings.model)}:config.endpoint);
const modelActive:Record<string,number>=Object.create(null);
let searchIntake=0;
const peak:Record<string,number>=Object.assign(Object.create(null),maybe(join(directory,'status.json'))?.peak);let closing=false;
const counters=()=>{
  const searchActive:Record<string,number>=Object.assign(Object.create(null),Object.fromEntries(service.search?.active??[]));
  if(searchIntake)searchActive.__unidentified__=(searchActive.__unidentified__??0)+searchIntake;
  const active:Record<string,number>=Object.assign(Object.create(null),modelActive);
  for(const [id,count] of Object.entries(searchActive))active[id]=(active[id]??0)+count;
  for(const [id,count] of Object.entries(active))peak[id]=Math.max(peak[id]??0,count);
  return {active,...(config.egress.searchPath?{searchActive,searchLedger:service.search?.ledger.snapshot()??null}:{})};
};
const status=()=>json(join(directory,'status.json'),{pid:process.pid,at:Date.now(),url:service.url,...counters(),peak,stopped:service.gateway.stopped});
service.server.on('request',(req,res)=>{
  if(req.url===SEARCH_ENDPOINT_PATH){
    searchIntake++;
    let done=false;
    const finish=()=>{if(done)return;done=true;searchIntake--;queueMicrotask(status);};
    req.once('end',finish);res.once('finish',finish);res.once('close',finish);
    return;
  }
  const active=modelActive;
  let data='';let configId='__unidentified__';active[configId]=(active[configId]??0)+1;
  let done=false;
  req.on('data',b=>{data+=b;if(data.length>32*1024*1024)data='';});req.on('end',()=>{if(done)return;try{const c=JSON.parse(data).configId;if(typeof c==='string'){active[configId]--;configId=c;active[c]=(active[c]??0)+1;}}catch{}status();});
  const finish=()=>{if(done)return;done=true;active[configId]--;status();};res.once('finish',finish);res.once('close',finish);
});
const timer=setInterval(status,50);timer.unref();
// T9 C1 #32: the egress process's own load, appended every 5 s (cumulative CPU microseconds, resident bytes, requests in flight).
setInterval(()=>log(join(directory,'status.jsonl'),{at:Date.now(),...counters(),cpuUsage:process.cpuUsage(),rssBytes:process.memoryUsage.rss()}),5000).unref();
const channel=await control(join(root,'scheduler','egress'),read(join(root,'plan.json')).runId+'/egress',async()=>{if(closing)return;closing=true;await service.close();clearInterval(timer);status();channel.close();});
process.once('exit',code=>json(join(root,'scheduler','egress','exit.json'),{code,at:now()},true));
process.on('SIGTERM',async()=>{if(closing)return;closing=true;await service.close();clearInterval(timer);status();channel.close();});
status();log(join(root,'scheduler','events.jsonl'),{at:now(),kind:'egress-ready',pid:process.pid,url:service.url});
