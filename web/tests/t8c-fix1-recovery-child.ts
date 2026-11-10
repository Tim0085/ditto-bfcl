import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {json} from '../src/ts/scheduler/io.ts';
const root=resolve(process.argv[2]),before=process.argv.includes('--before'),module=await import(pathToFileURL(resolve(before?'before/src/ts/scheduler/egress.ts':'src/ts/scheduler/egress.ts')).href);
try{const result=await module.recoverEgress(root,'Authorized offline regression: reconcile this isolated crash; preserve unknown fees');json(join(root,'recover-'+process.argv[3]+'.json'),{ok:true,result},true);console.log(JSON.stringify({ok:true,result}));}
catch(error){json(join(root,'recover-'+process.argv[3]+'.json'),{ok:false,error:String(error)},true);console.error(String(error));process.exitCode=2;}
