import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function runWebBPython(script: string, input: string) {
  const python = process.platform === 'win32' ? 'E:/Anaconda3/python.exe' : 'python3';
  const result = spawnSync(python, ['-B', '-X', 'utf8', join('tests', script), input],
    { encoding: 'utf8', windowsHide: true });
  console.log(result.stdout);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  console.log(result.stderr);
}
