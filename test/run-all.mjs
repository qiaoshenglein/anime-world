// 一条命令跑完全部联网测试：自起临时服务端 → 协议冒烟 → 联网层集成 → 公网加固
// 运行: bun test/run-all.mjs
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1');
const PORT = 8790;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), QUIET: '1' }, stdout: 'ignore', stderr: 'inherit',
});
const URL_ = `ws://localhost:${PORT}/ws`;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break; } catch { await sleep(200); }
}

let bad = 0;
for (const [name, file] of [['协议冒烟', 'net-smoke.mjs'], ['联网层集成', 'net-client.mjs'], ['公网加固', 'hardening.mjs']]) {
  console.log(`\n──────── ${name} (${file}) ────────`);
  const p = Bun.spawn([process.execPath, 'test/' + file], {
    cwd: ROOT, env: { ...process.env, URL: URL_ }, stdout: 'inherit', stderr: 'inherit',
  });
  const code = await p.exited;
  if (code !== 0) bad++;
}
srv.kill();
console.log('\n' + (bad ? `${bad} 个套件失败` : '全部套件通过'));
process.exit(bad ? 1 : 0);
