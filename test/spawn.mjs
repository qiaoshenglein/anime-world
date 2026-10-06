// 测试用服务端启动器：默认 PORT=0 让系统挑空闲端口，再从 AW_PORT_FILE 读回真实端口。
// 写死端口看似省事，实则会被上一轮没杀干净的旧服务端悄悄顶替——新代码根本没被测到。
// 校验方式：/healthz 必须带 db 字段（只有当前版本才有），否则说明连到的是遗留进程。
import { readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer(root, env = {}, { tag = 'aw', port = 0, stderr = 'inherit' } = {}) {
  const pf = `${root}test/.port-${tag}`;
  rmSync(pf, { force: true });
  const proc = Bun.spawn([process.execPath, 'server/index.js'], {
    cwd: root,
    env: { ...process.env, QUIET: '1', ...env, PORT: String(port || 0), AW_PORT_FILE: pf, AW_DB: env.AW_DB || '' },
    stdout: 'ignore',
    stderr,
  });
  const t0 = Date.now();
  let bound = 0;
  while (Date.now() - t0 < 8000) {
    if (existsSync(pf)) { bound = Number(readFileSync(pf, 'utf8')); if (bound > 0) break; }
    await sleep(50);
  }
  if (!bound) { proc.kill(); throw new Error(`[${tag}] 服务端没能启动（没报端口）`); }
  const base = `http://localhost:${bound}`;
  let h = null;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) { h = await r.json(); break; } } catch {}
    await sleep(80);
  }
  if (!h) { proc.kill(); throw new Error(`[${tag}] ${bound} 端口健康检查不通`); }
  if (!('db' in h)) { proc.kill(); throw new Error(`[${tag}] ${bound} 端口上是遗留的旧服务端（/healthz 没有 db 字段），请清理进程`); }
  writeFileSync(pf, String(bound));
  return {
    proc, port: bound, base, ws: `ws://localhost:${bound}/ws`,
    async stop(kill = true) { if (kill) proc.kill(); rmSync(pf, { force: true }); await sleep(120); },
  };
}
