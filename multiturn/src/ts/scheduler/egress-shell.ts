import {join,resolve} from 'node:path';
import {startEgress} from '../egress/server.ts';
import {read,json,now,log,maybe} from './io.ts';
import {control} from './control.ts';
const root=resolve(process.argv[2]),config=read(join(root,'plan.json')).stage,liveMode=config.egress.backend==='live'&&config.egress.mode==='live';
if(!liveMode&&(!['fixtures','replay'].includes(config.egress.backend)||config.egress.mode!=='offline-reference'))throw new Error('Only offline egress is authorized');
// T9 B: a real egress runs under the live guard alone. A forged launch was given the offline guard and stops here.
const liveGuard=(globalThis as any)[Symbol.for('ditto.egress.liveGuard')],offlineGuard=(globalThis as any)[Symbol.for('ditto.egress.offlineGuard')];
if(liveMode?!process.argv[3]||!liveGuard||offlineGuard:process.argv[3]||liveGuard)throw new Error('A real egress needs a key file and the live guard alone; an offline egress takes neither');
// T8a fix 6: written before startEgress takes gateway.lock, so a hard kill during startup is still attributable.
json(join(root,'scheduler','egress','pid.json'),{pid:process.pid,at:now()});
const directory=join(root,'egress'),service=await startEgress(config.egress,directory,liveMode?{...config.endpoint,live:true,credentials:liveGuard.readCredentials(config.egress.settings.model)}:config.endpoint);
const active:Record<string,number>={},peak:Record<string,number>={...(maybe(join(directory,'status.json'))?.peak??{})};let closing=false;
const status=()=>json(join(directory,'status.json'),{pid:process.pid,at:Date.now(),url:service.url,active,peak,stopped:service.gateway.stopped});
service.server.on('request',(req,res)=>{let data='';let configId='__unidentified__';active[configId]=(active[configId]??0)+1;
  req.on('data',b=>{data+=b;if(data.length>32*1024*1024)data='';});req.on('end',()=>{try{const c=JSON.parse(data).configId;if(typeof c==='string'){active[configId]--;configId=c;active[c]=(active[c]??0)+1;peak[c]=Math.max(peak[c]??0,active[c]);}}catch{}status();});
  let done=false;const finish=()=>{if(done)return;done=true;active[configId]--;status();};res.once('finish',finish);res.once('close',finish);
});
const timer=setInterval(status,50);timer.unref();
// T9 C1 #32: the egress process's own load, appended every 5 s (cumulative CPU microseconds, resident bytes, requests in flight).
setInterval(()=>log(join(directory,'status.jsonl'),{at:Date.now(),active:{...active},cpuUsage:process.cpuUsage(),rssBytes:process.memoryUsage.rss()}),5000).unref();
const channel=await control(join(root,'scheduler','egress'),read(join(root,'plan.json')).runId+'/egress',async()=>{if(closing)return;closing=true;await service.close();clearInterval(timer);status();channel.close();});
process.once('exit',code=>json(join(root,'scheduler','egress','exit.json'),{code,at:now()},true));
process.on('SIGTERM',async()=>{if(closing)return;closing=true;await service.close();clearInterval(timer);channel.close();});
status();log(join(root,'scheduler','events.jsonl'),{at:now(),kind:'egress-ready',pid:process.pid,url:service.url});
