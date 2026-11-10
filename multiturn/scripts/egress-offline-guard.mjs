// 测试前加载：拒绝凭据文件和非本机网络；只输出访问计数，不记录环境变量值。
// 必须先在进程共享区判重，再导入runtime；第二份绝不能再次解析真实private目录。
const key = Symbol.for('ditto.egress.offlineGuard');
if (globalThis[key]) {
  const state = globalThis[key];
  state.entries.add(import.meta.url);
  state.duplicateLoads++;
  await state.ready;
} else {
  const state = {entries:new Set([import.meta.url]),duplicateLoads:0,ready:null};
  globalThis[key] = state;
  state.ready = import('./offline-guard-runtime.mjs');
  await state.ready;
}
