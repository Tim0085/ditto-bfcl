import {mkdir,readdir,lstat,readFile,writeFile} from 'node:fs/promises';
import {join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
export const bases=['node@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8','python@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db'];
const excluded=(name:string)=>{const lower=name.toLowerCase();return lower.startsWith('.env')||['private','.git','__pycache__','runs','tests','docs'].includes(lower)||lower.endsWith('.pyc');};
// One allowlist and one ordering for builds and releases. No credentials discovery.
export async function imageContext(root:string,destination?:string){
  const files:{path:string;sha256:string;size:number}[]=[];
  async function visit(source:string,path:string){
    const stat=await lstat(source);if(stat.isSymbolicLink())throw Error(`Unexpected link: ${source}`);
    if(stat.isDirectory()){for(const n of (await readdir(source)).sort())if(!excluded(n))await visit(join(source,n),path+'/'+n);return;}
    const bytes=await readFile(source);
    if(destination){const dest=join(destination,path);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes);}
    files.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
  }
  for(const path of ['package.json','src','scripts','vendor','data'])await visit(join(root,path),path);
  for(const path of ['egress.offline.json','egress.live.example.json','egress.throughput.json'])await visit(join(root,'config',path),'config/'+path);
  await visit(join(root,'vendor','ditto'),'node_modules/@codesoul-co/ditto');
  await visit(join(root,'node_modules','yaml'),'node_modules/yaml');
  await visit(join(root,'docker','Dockerfile'),'Dockerfile');await visit(join(root,'docker','.dockerignore'),'.dockerignore');
  files.sort((a,b)=>a.path.localeCompare(b.path));
  return {fingerprint:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
}
export async function testFingerprint(root:string,manifest:string,context:string){
  const hash=createHash('sha256').update(context).update(await readFile(manifest));
  async function visit(dir:string){for(const n of (await readdir(dir)).sort()){
    if(excluded(n)&&n!=='tests')continue;
    const p=join(dir,n),s=await lstat(p);if(s.isSymbolicLink())throw Error('Linked test input');
    if(s.isDirectory())await visit(p);else hash.update(relative(root,p)).update(await readFile(p));
  }}
  await visit(join(root,'tests'));hash.update(await readFile(join(root,'tsconfig.json')));
  return hash.digest('hex');
}
export async function verifyWorktreeImage(root:string,info:any,tag:string){
  const actual=(await imageContext(root)).fingerprint,label=info.Config.Labels?.['sec1.context'];
  if(label!==actual)throw Error(`Image/worktree context mismatch: image=${label??'missing'}, worktree=${actual}`);
  if(/^exp\d+-v\d+$/.test(tag)){
    const ledger=JSON.parse(await readFile(join(root,'docker/images.json'),'utf8'));
    const rows=Array.isArray(ledger)?ledger.filter((r:any)=>r.version===tag):[];
    if(rows.length!==1||rows[0].imageId!==info.Id||rows[0].fingerprint!==actual)throw Error(`Release ledger mismatch for ${tag}: image=${label}, worktree=${actual}, ledger=${rows[0]?.fingerprint??'missing'}`);
  }
}
