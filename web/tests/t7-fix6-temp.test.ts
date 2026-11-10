import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {childEnvironment} from '../src/ts/deploy.ts';
import {temporary,block,egress} from './t7-helpers.ts';

test('fix6 absent, empty, case-insensitive temp whitelist and unrelated secret',async()=>{
  assert.deepEqual(childEnvironment({SEC1_FAKE_SECRET:'no'}),{PYTHONDONTWRITEBYTECODE:'1'});
  assert.deepEqual(childEnvironment({Temp:'a',TMP:'',TMPDIR:'b',SEC1_FAKE_SECRET:'no'}),{Temp:'a',TMP:'',TMPDIR:'b',PYTHONDONTWRITEBYTECODE:'1'});
  // No tempfile API in this absence probe: observing the old fallback must not create C-drive files.
  const env=childEnvironment();delete env.TEMP;delete env.TMP;delete env.TMPDIR;
  // Windows Node may copy TEMP from the spawning parent even with an explicit env.
  const saved=[process.env.TEMP,process.env.TMP,process.env.TMPDIR];
  let child:ReturnType<typeof spawn>;
  try{
    delete process.env.TEMP;delete process.env.TMP;delete process.env.TMPDIR;
    child=spawn(process.execPath,['-e','console.log(JSON.stringify({env:[process.env.TEMP??null,process.env.TMP??null,process.env.TMPDIR??null],tmpdir:require("node:os").tmpdir()}))'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  }finally{['TEMP','TMP','TMPDIR'].forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});}
  let out='',err='';child.stdout!.on('data',b=>out+=b);child.stderr!.on('data',b=>err+=b);
  const code=await new Promise(r=>child.once('close',r));assert.equal(code,0,err);
  assert.deepEqual(JSON.parse(out).env,[null,null,null]);assert.equal(typeof JSON.parse(out).tmpdir,'string');console.log(JSON.stringify({absentChild:JSON.parse(out)}));
});

test('fix6 real CLI Direct and Worker Python inherit F-drive temporary directory',async()=>{
  if(!process.env.TEMP&&!process.env.TMP&&!process.env.TMPDIR){
    // Python gettempdir probes writability by creating a file; do not call it in the absent case.
    assert.equal(typeof tmpdir(),'string');
    console.log(JSON.stringify({mode:'all-temp-variables-absent',tmpdir:tmpdir(),readOnly:true,cliAndPythonNotStarted:true}));return;
  }
  const root=await temporary();console.log(JSON.stringify({evidence:root}));
  const gateway=await egress(root,'replay');
  try{for(const group of ['Direct','Monolithic'] as const){
    const dir=join(root,group);await mkdir(dir);
    const events=join(dir,'events.jsonl'),wrapper=join(dir,'observe-python.py');
    await writeFile(wrapper,`import os,sys,json,tempfile,runpy\nwith open(${JSON.stringify(events)},'a',encoding='utf8') as f:\n f.write(json.dumps(dict(kind='python',pid=os.getpid(),tmpdir=tempfile.gettempdir(),TEMP=os.getenv('TEMP'),TMP=os.getenv('TMP'),TMPDIR=os.getenv('TMPDIR'),secret=os.getenv('SEC1_FAKE_SECRET')))+'\\n')\nrunpy.run_path(sys.argv[1],run_name='__main__')\n`);
    const hook=pathToFileURL(resolve('tests/t7-fix6-hook.mjs'));hook.searchParams.set('cfg',JSON.stringify({events,wrapper,observe:true}));
    const b=await block(dir,gateway.url,group,'temp'),config=join(dir,'block.json');await writeFile(config,JSON.stringify(b));
    const env={...childEnvironment(),SEC1_FAKE_SECRET:'must-not-arrive',NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${hook.href}`};
    const child=spawn(process.execPath,['--experimental-transform-types','src/ts/config-main.ts','--block',config],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const code=await new Promise(r=>child.once('close',r));await writeFile(join(dir,'process.json'),JSON.stringify({code,stdout,stderr}));assert.equal(code,0,stderr);
    const rows=(await readFile(events,'utf8')).trim().split('\n').map(s=>JSON.parse(s));
    assert(rows.some(r=>r.kind==='cli'));assert(rows.some(r=>r.kind==='python'));assert.equal(rows.some(r=>r.kind==='worker'),group==='Monolithic');
    for(const r of rows){assert.equal(resolve(r.tmpdir),resolve(tmpdir()));for(const key of ['TEMP','TMP','TMPDIR'])assert.equal(r[key]??null,process.env[key]??null,key);assert.equal(r.secret,null);}
    console.log(JSON.stringify({group,rows}));
  }}finally{await gateway.close();}
});
