import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,readdirSync,renameSync,unlinkSync,linkSync,openSync,readSync,closeSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export const guard=pathToFileURL(join(ROOT,'scripts/egress-offline-guard.mjs')).href;
export const now=()=>new Date().toISOString();
export const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export const digest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function read<T=any>(path:string):T {const text=readFileSync(path,'utf8');try{return JSON.parse(text);}catch(error){throw new SyntaxError('Invalid JSON record '+path+': '+String(error),{cause:error});}}
export function maybe<T=any>(path:string):T|undefined {try{return read<T>(path);}catch(e){if((e as any).code==='ENOENT')return;throw e;}}
export function json(path:string,value:unknown,exclusive=false){mkdirSync(dirname(path),{recursive:true});const data=JSON.stringify(value,null,2)+'\n';const temp=path+'.pending-'+randomUUID();try{writeFileSync(temp,data,{flag:'wx'});if(exclusive)linkSync(temp,path);else{for(let attempt=0;;attempt++){try{renameSync(temp,path);break;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes((error as any).code)||attempt===100)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}}}finally{if(existsSync(temp))unlinkSync(temp);}}
export function log(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true});appendFileSync(path,JSON.stringify(value)+'\n');}
export function lines(path:string,tolerateTail=false):any[]{if(!existsSync(path))return [];const text=readFileSync(path,'utf8');const rows=text.split('\n');if(rows.at(-1)==='')rows.pop();else if(tolerateTail)rows.pop();return rows.filter(Boolean).map(s=>JSON.parse(s));}
// T10: the rows lines() returns, handed over one at a time. The file is read in 1 MiB pieces and cut at '\n' bytes (UTF-8
// never uses that byte inside a character), so neither the whole text nor all rows are held. Same rules as lines():
// empty lines skipped, every other line parsed (a damaged one throws), a last line without '\n' dropped when tolerateTail.
export function eachLine(path:string,tolerateTail:boolean,visit:(row:any)=>void){
  if(!existsSync(path))return;
  const fd=openSync(path,'r'),piece=Buffer.allocUnsafe(1<<20),emit=(bytes:Buffer)=>{const s=bytes.toString('utf8');if(s)visit(JSON.parse(s));};let tail=Buffer.alloc(0);
  try{for(let n;(n=readSync(fd,piece,0,piece.length,null))>0;){const data=tail.length?Buffer.concat([tail,piece.subarray(0,n)]):piece.subarray(0,n);let start=0;
    for(let end;(end=data.indexOf(10,start))!==-1;start=end+1)emit(data.subarray(start,end));
    tail=Buffer.from(data.subarray(start));}}
  finally{closeSync(fd);}
  if(tail.length&&!tolerateTail)emit(tail);
}
export function auxiliaryLines(path:string):any[]{try{if(!existsSync(path))return [];return readFileSync(path,'utf8').split('\n').filter(Boolean).map((raw,index)=>{try{const row=JSON.parse(raw);if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Object required');return row;}catch{return {malformed:true,source:path,line:index+1,reason:'Invalid auxiliary JSONL record'};}});}catch(error){return [{malformed:true,source:path,reason:String(error)}];}}
export function files(dir:string):string[]{if(!existsSync(dir))return [];return readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(e=>e.isSymbolicLink()?[]:e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
export function env(report:string,extraImports:string[]=[]):NodeJS.ProcessEnv{return {PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONDONTWRITEBYTECODE:'1',NODE_OPTIONS:[`--import=${guard}`,...extraImports.map(s=>'--import='+s)].join(' '),OFFLINE_GUARD_REPORT_DIR:report};}
export function alive(pid:number){try{process.kill(pid,0);return true;}catch(error){return (error as any)?.code==='EPERM';}}
export function removeOwn(path:string){if(existsSync(path))unlinkSync(path);}
export function id(value:string){if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid identifier');return value;}
