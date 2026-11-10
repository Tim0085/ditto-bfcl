import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("Web backend fixture, replay, live stubs and official scoring",()=>{
  const python=process.platform==="win32"?"E:/Anaconda3/python.exe":"python3";
  const result=spawnSync(python,["-B","-S","-X","utf8","tests/python/test_web.py"],{encoding:"utf8",windowsHide:true});
  console.log(result.stdout);
  assert.equal(result.status,0,result.error?.message??result.stderr);
  console.log(result.stderr);
});
