// 公网加固项验证：自带一个专用服务端实例（收紧限额，便于触发边界）
// 运行: bun test/hardening.mjs
const R = [];
const ok = (n, c, extra) => R.push((c ? 'PASS ' : 'FAIL ') + n + (extra ? '  [' + extra + ']' : ''));
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1');
const PORT = 8791;
const URL_ = `ws://localhost:${PORT}/ws`;
const HTTP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), QUIET: '1', MAX_PER_IP: '2', MAX_CONNS: '8', IDLE_KILL_S: '1', MSG_MAX_BYTES: '512' },
  stdout: 'ignore', stderr: 'pipe',
});

const health = () => fetch(HTTP + '/healthz').then((r) => r.json());
const metrics = () => fetch(HTTP + '/metrics').then((r) => r.json());
// 有限等待，任何情况下都不挂死
const settle = (ws, ms = 4000) => new Promise((res) => {
  const t = setTimeout(() => res('timeout'), ms);
  const done = (v) => { clearTimeout(t); res(v); };
  ws.addEventListener('open', () => done('open'), { once: true });
  ws.addEventListener('error', () => done('error'), { once: true });
  ws.addEventListener('close', (e) => done(e.code || 'close'), { once: true });
});
const waitConns = async (pred, ms = 9000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred(await health())) return true; await sleep(300); }
  return false;
};

for (let i = 0; i < 50; i++) { try { if ((await health()).ok) break; } catch { await sleep(200); } }

// 1. 健康检查形状
const h = await health();
ok('healthz 报告运行指标', h.ok === true && 'conns' in h && 'online' in h && 'tls' in h, JSON.stringify(h));

// 2. 静态压缩与缓存协商（用原始 socket 量传输字节：fetch 会自动解压，量不到真实开销）
const { connect } = await import('node:net');
const rawGet = (enc) => new Promise((res) => {
  const s = connect(PORT, '127.0.0.1', () => s.write(`GET /index.html HTTP/1.1\r\nHost: x\r\nAccept-Encoding: ${enc}\r\nConnection: close\r\n\r\n`));
  let n = 0, buf = '', head = ''; // 响应可能以极小分片流式到达，头部要跨分片累积
  s.on('data', (b) => {
    n += b.length;
    if (head) return;
    buf += b.toString('latin1');
    const i = buf.indexOf('\r\n\r\n');
    if (i >= 0) head = buf.slice(0, i);
  });
  s.on('end', () => res({ n, head }));
  s.on('error', () => res({ n: -1, head: '' }));
});
const ident = await rawGet('identity');
const gzres = await rawGet('gzip');
ok('index 走 gzip 明显瘦身', /content-encoding: *gzip/i.test(gzres.head) && gzres.n < ident.n / 2,
  `${(ident.n / 1024) | 0}KB → ${(gzres.n / 1024) | 0}KB`);
const etag = (/etag: *(\S+)/i.exec(ident.head) || [])[1];
const r2 = await fetch(HTTP + '/index.html', { headers: { 'if-none-match': etag || '' } });
ok('同 ETag 二次请求返回 304', !!etag && r2.status === 304, 'status=' + r2.status);

// 3. 超大单帧：连接须被拒绝，且不得建号
const online0 = (await health()).online;
const big = new WebSocket(URL_);
const bigOpen = await settle(big);
if (bigOpen === 'open') big.send('x'.repeat(4096));
const bigClose = await settle(big, 4000);
await sleep(400);
const online1 = (await health()).online;
ok('超大单帧被拒且未建号', bigClose !== 'open' && bigClose !== 'timeout' && online1 === online0,
  `关闭码=${bigClose} online ${online0}→${online1}`);

// 4. 握手洪泛：同 socket 反复 hello 只对应一个玩家
const flood = new WebSocket(URL_);
await settle(flood);
let pid = null;
flood.addEventListener('message', (e) => {
  const d = JSON.parse(String(e.data));
  if (d.t === 'hello' && !pid) { pid = d.pid; flood.send(JSON.stringify({ t: 'join', r: 'sakura', l: 0, p: { n: '洪泛者' } })); }
});
for (let i = 0; i < 60; i++) flood.send(JSON.stringify({ t: 'hello' }));
await sleep(600);
const rooms = await fetch(HTTP + '/rooms').then((r) => r.json());
const members = rooms.rooms.reduce((a, x) => a + x.on, 0);
ok('重复 hello 不刷出多余玩家', !!pid && members === 1, '成员=' + members);
flood.close();
await waitConns((x) => x.conns === 0);

// 5. 只连不握手 → 空闲回收
const before = (await health()).conns;
const ghost = new WebSocket(URL_);
await settle(ghost);
const peaked = await waitConns((x) => x.conns > before, 4000);
await sleep(7000); // IDLE_KILL_S=1，扫描周期 5s
const after = (await health()).conns;
ok('未握手连接被自动回收', peaked && after <= before, `conns ${before} → 峰值+1 → ${after}`);

// 6. 单 IP 限额（MAX_PER_IP=2）
const rej0 = (await metrics()).rejected;
const keep = [new WebSocket(URL_), new WebSocket(URL_)];
const opened = await Promise.all(keep.map((w) => settle(w)));
const third = new WebSocket(URL_);
const thirdResult = await settle(third, 3000);
const rej1 = (await metrics()).rejected;
ok('超过单 IP 在连上限被拒', opened.every((r) => r === 'open') && thirdResult !== 'open' && rej1 > rej0,
  `前两条=${opened.join(',')} 第三条=${thirdResult} rejected ${rej0}→${rej1}`);
const busy = new WebSocket(URL_);
const busyRes = await settle(busy, 2000);
ok('限额期间新连接收到 503', busyRes !== 'open', '结果=' + busyRes);

// 7. 断开后 IP 计数释放
for (const w of keep) w.close();
await sleep(600);
const released = new WebSocket(URL_);
const relRes = await settle(released, 3000);
ok('连接关闭后额度即时释放', relRes === 'open', '结果=' + relRes);
released.close();

await sleep(200);
srv.kill(9);
console.log(R.join('\n'));
const failed = R.filter((x) => x.startsWith('FAIL')).length;
console.log(failed ? `HARDENING FAIL (${failed}/${R.length})` : `HARDENING PASS (${R.length} 项)`);
process.exit(failed ? 1 : 0);
