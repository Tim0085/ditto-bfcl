import { opendir, lstat, readlink, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
const root=resolve('../../bfcl_direct'), output=resolve('runs/offline/t5-acceptance');
await mkdir(output,{recursive:true});
const rows=[];
async function visit(path){
  for await(const item of await opendir(path)){
    const full=join(path,item.name), name=relative(root,full).replaceAll('\\','/');
    const st=await lstat(full,{bigint:true});
    if(item.name.startsWith('.env')||item.name==='private'||/credentials/i.test(item.name)){
      rows.push({name,excluded:true,size:String(st.size),mtime:String(st.mtimeNs)});continue;
    }
    if(st.isSymbolicLink()){rows.push({name,link:await readlink(full),mtime:String(st.mtimeNs)});continue;}
    if(st.isDirectory()){await visit(full);continue;}
    const hash=createHash('sha256'); for await(const chunk of createReadStream(full))hash.update(chunk);
    rows.push({name,size:String(st.size),mtime:String(st.mtimeNs),sha256:hash.digest('hex')});
  }
}
await visit(root); rows.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
const data=JSON.stringify(rows,null,2)+'\n', mode=process.argv[2]??'before';
await writeFile(join(output,`legacy-${mode}.json`),data,{flag:'wx'});
if(mode!=='before'){
  const before=JSON.parse(await readFile(join(output,'legacy-before.json'),'utf8'));
  if(JSON.stringify(before)!==JSON.stringify(rows))throw new Error('Legacy snapshot differs');
}
console.log(JSON.stringify({mode,entries:rows.length,hashed:rows.filter(x=>x.sha256).length,excluded:rows.filter(x=>x.excluded).map(x=>x.name),links:rows.filter(x=>x.link).length,match:mode==='before'?null:true}));
