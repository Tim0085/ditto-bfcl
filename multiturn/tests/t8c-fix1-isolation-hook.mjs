// Only route the existing tests' historical relative READ paths in the deeper
// isolated checkout. The original package and all production modules stay intact.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const cwd=process.cwd().replaceAll('\\','/');
if(cwd.includes('/_tmp/iso/t8c-fix1')){
  const alias=resolve('../../bfcl_direct'),actual='F:/Academic/Ditto/experiments/bfcl_direct';
  const route=value=>{
    if(value instanceof URL)value=fileURLToPath(value);
    if(typeof value!=='string')return value;
    const absolute=resolve(value);
    if(absolute===alias||absolute.startsWith(alias+sep))return actual+absolute.slice(alias.length).replaceAll('\\','/');
    return value;
  };
  for(const object of [fs,fsp])for(const name of ['readFile','readFileSync','stat','statSync','lstat','lstatSync','access','accessSync','readdir','readdirSync','existsSync','createReadStream']){
    if(typeof object[name]!=='function')continue;const native=object[name];object[name]=function(path,...args){return native.call(this,route(path),...args);};
  }
  const spawn=cp.spawn;cp.spawn=function(file,args,options){return spawn.call(this,file,Array.isArray(args)?args.map(route):args,options);};
  syncBuiltinESMExports();
}
