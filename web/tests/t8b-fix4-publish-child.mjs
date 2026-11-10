import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const [ledger,manifest,logs,barrier]=process.argv.slice(2),original=fs.writeFile;
fs.writeFile=async function(path,body,...args){
  if(String(path).startsWith(ledger+'.pending-')){
    await original(path,body.slice(0,Math.floor(body.length/2)),...args);
    await original(barrier,'half-written');
    await new Promise(()=>setInterval(()=>{},1000));
  }
  return original(path,body,...args);
};syncBuiltinESMExports();
const {publishImage}=await import('../src/ts/docker/release.ts');
await publishImage({version:'0.0.8405',ledger,tests:manifest,logs,sourceTag:'test-t8b-fix4-publish'});
