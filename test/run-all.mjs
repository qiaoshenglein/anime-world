// 一条命令跑完全部联机相关测试：每个套件各起自己的服务端（并发跑，总耗时 ≈ 最慢的套件）
// 运行: bun test/run-all.mjs        只跑其中几个: bun test/run-all.mjs net-smoke ui-wiring
import { startServer } from './spawn.mjs';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1');
const only = process.argv.slice(2);

// 需要独立服务端的一律独占进程：/metrics 计数、石碑、世界阶段都是全局态，共用必然互相污染
const SUITES = [
  { name: '协议冒烟', file: 'net-smoke.mjs', srv: 'smoke', srvEnv: { WEATHER_MS: '600' } },
  { name: '联网层集成', file: 'net-client.mjs', srv: 'client', srvEnv: { WEATHER_PIN: 'rain' } }, // 钉成细雨：天气奖励那条路要能被确定性验
  { name: '公网加固', file: 'hardening.mjs' },        // 自带服务端
  { name: '账号与权威', file: 'account.mjs' },         // 自带服务端 + 重启 + CLI
  { name: '纯逻辑（库/鉴权）', file: 'db-auth.mjs' },   // 无服务端
  { name: '联机接线', file: 'ui-wiring.mjs' },          // 静态检查
  { name: '真浏览器流程', file: 'ui-probe.mjs', chrome: true }, // headless Chrome 走玩家那条路
];

// 探针跑的是打包后的 index.html：先重新打包，否则测的是旧产物
const built = await Bun.spawn([process.execPath, 'build.js'], { cwd: ROOT, stdout: 'ignore', stderr: 'inherit' }).exited;
if (built !== 0) { console.log('✗ 打包失败，测试中止'); process.exit(1); }

const runs = [];
for (const s of SUITES) {
  if (only.length && !only.some((x) => s.file.includes(x) || s.name.includes(x))) continue;
  runs.push(async () => {
    let srv = null;
    const env = { ...process.env, QUIET: '1', ...s.srvEnv };
    if (s.srv) {
      try { srv = await startServer(ROOT, { AW_DB: '', ...s.srvEnv }, { tag: s.srv }); }
      catch (e) { console.log(`✗ ${s.name}：${e.message}`); return { name: s.name, code: 1 }; }
      env.URL = `ws://localhost:${srv.port}/ws`;
    }
    console.log(`\n──────── ${s.name} (${s.file}) ────────`);
    const p = Bun.spawn([process.execPath, 'test/' + s.file], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' });
    const code = await p.exited;
    srv?.proc.kill();
    return { name: s.name, code };
  });
}

const results = await Promise.all(runs.map((f) => f()));
const bad = results.filter((r) => r.code !== 0);
console.log('\n' + results.map((r) => (r.code ? '✗ ' : '✓ ') + r.name).join('\n'));
console.log(bad.length ? `\n${bad.length} 个套件失败：${bad.map((b) => b.name).join('、')}` : '\n全部套件通过');
process.exit(bad.length ? 1 : 0);
