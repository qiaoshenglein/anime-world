// 星屑物语 · 多人联机服务端
// 本机: bun server/index.js            公网: bash deploy/start.sh   （详见 docs/deploy.md）
// 协议与设计: docs/server-design.md
import { networkInterfaces } from 'node:os';

const env = process.env;
const cfg = {
  port: Number(env.PORT || 8770),
  host: env.HOST || '0.0.0.0',
  tlsCert: env.TLS_CERT || null,
  tlsKey: env.TLS_KEY || null,
  maxPlayers: Number(env.MAX_PLAYERS || 24),   // 单 lane 上限
  lanes: Number(env.LANES || 4),
  maxConns: Number(env.MAX_CONNS || 512),      // 全局在连 socket
  maxPerIp: Number(env.MAX_PER_IP || 8),       // 单 IP 在连数
  msgMaxBytes: Number(env.MSG_MAX_BYTES || 2048),
  idleKillMs: Number(env.IDLE_KILL_S || 15) * 1000,   // 从未握手的连接回收
  slotTtlMs: Number(env.SLOT_TTL_S || 30) * 1000,     // 断线重连槽位保留
  msgRate: Number(env.MSG_RATE || 60),         // 入站消息/秒
  chatRate: Number(env.CHAT_RATE || 1.2),
  trustProxy: env.TRUST_PROXY === '1',
  quiet: env.QUIET === '1',
  speedLimit: Number(env.SPEED_LIMIT || 20),   // 位移合理性 u/s
  root: new URL('..', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1'),
};
const wsScheme = cfg.tlsCert ? 'wss' : 'ws';
const httpScheme = cfg.tlsCert ? 'https' : 'http';

const NAME_RE = /^[\w\u4E00-\u9FFF ·A-Za-z0-9]{1,16}$/;

const rooms = new Map();    // room -> [lane0, lane1...]，lane = Map<playerId, Player>
const players = new Map();  // playerId -> Player
const pending = new Map();  // token -> Player（握手后未入房的槽位，超时回收）
const live = new Set();     // {ws, ip, helloAt, joined} 在连记录
const byIp = new Map();     // ip -> count
const stats = { msgIn: 0, msgOut: 0, drops: 0, rejected: 0, startedAt: Date.now() };

const lane = (room, l) => {
  let lm = rooms.get(room);
  if (!lm) rooms.set(room, (lm = []));
  while (lm.length <= l) lm.push(new Map());
  return { room, l, map: lm[l] };
};
let rid = 0;
const genId = () => 'p' + (++rid).toString(36) + Math.random().toString(36).slice(2, 6);
const genTok = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const clamp = (v, a, b) => (typeof v === 'number' && isFinite(v) ? Math.max(a, Math.min(b, v)) : null);
const num = (v, a, b, dflt = 0) => clamp(v, a, b) ?? dflt;
const now = () => Date.now();
const log = (...a) => { if (!cfg.quiet) console.log(...a); };

function clientIp(req, server) {
  if (cfg.trustProxy) {
    const xf = req.headers.get('x-forwarded-for');
    if (xf) return xf.split(',')[0].trim();
  }
  const ip = server.requestIP(req);
  return ip ? ip.address : 'unknown';
}

function send(ws, obj) {
  const s = JSON.stringify(obj);
  stats.msgOut++;
  try { ws.send(s); } catch {}
}
function broadcastExcept(laneMap, fromPid, obj) {
  const s = JSON.stringify(obj);
  stats.msgOut++;
  for (const p of laneMap.values()) if (p.id !== fromPid && p.joined) { try { p.ws.send(s); } catch {} }
}
function broadcastAll(laneMap, obj) {
  const s = JSON.stringify(obj);
  stats.msgOut++;
  for (const p of laneMap.values()) if (p.joined) { try { p.ws.send(s); } catch {} }
}
const rosterOf = (laneMap) => [...laneMap.values()].filter((p) => p.joined).map((p) => p.public());

// ---------------------------------------------------------------- player
class Player {
  constructor(ws, id, tok) {
    this.ws = ws; this.id = id; this.tok = tok;
    this.name = '旅人'; this.look = null; this.joined = false;
    this.room = 'sakura'; this.laneL = 0;
    this.x = 0; this.y = 2; this.z = 16; this.Y = Math.PI;
    this.a = { sp: 0, glid: 0, sw: 0, air: 0, jmp: 0, hit: 0, dead: 0 };
    this.ts = now(); this.lastIn = now(); this.lastChat = 0; this.msgBudget = cfg.msgRate;
    this.bannedUntil = 0;
  }
  public() {
    return { p: this.id, n: this.name, look: this.look, x: +this.x.toFixed(2), y: +this.y.toFixed(2), z: +this.z.toFixed(2), Y: +this.Y.toFixed(3), a: this.a };
  }
}

// ---------------------------------------------------------------- guard
function guard(p, d) {
  const t = now();
  if (t < p.bannedUntil) { stats.drops++; return false; }
  // 令牌桶：按时间连续补充（15Hz 客户端永不停顿，靠“停顿才补”会误封）
  p.msgBudget = Math.min(cfg.msgRate, (p.msgBudget || 0) + (t - p.lastIn) / 1000 * cfg.msgRate);
  p.lastIn = t;
  if (p.msgBudget < 1) { p.bannedUntil = t + 30000; stats.drops++; send(p.ws, { t: 'err', code: 'rate' }); return false; }
  p.msgBudget -= 1;
  const x = clamp(d.x, -420, 420), y = clamp(d.y, -40, 260), z = clamp(d.z, -420, 420);
  const Yraw = typeof d.Y === 'number' && isFinite(d.Y) ? d.Y : null;
  if (x == null || y == null || z == null || Yraw == null) { stats.drops++; return false; }
  const Y = ((Yraw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; // 朝向归一化，不因累积转圈而丢帧
  const dt = Math.max(0.05, Math.min(2, (d.ts ? t - p.ts : 200) / 1000)); p.ts = t;
  const dist = Math.hypot(x - p.x, z - p.z);
  if (dist > cfg.speedLimit * dt + 8) { stats.drops++; return false; } // 瞬移/倍速：丢弃该帧
  p.x = x; p.y = y; p.z = z; p.Y = Y;
  const a = d.a || {};
  p.a = { sp: +num(a.sp, 0, 25).toFixed(1), glid: a.glid ? 1 : 0, sw: a.sw ? 1 : 0, air: a.air ? 1 : 0, jmp: a.jmp ? 1 : 0, hit: a.hit ? 1 : 0, dead: a.dead ? 1 : 0 };
  return true;
}

// ---------------------------------------------------------------- handlers
function handleJoin(p, d) {
  const room = typeof d.r === 'string' && /^[a-z]{3,16}$/.test(d.r) ? d.r : 'sakura';
  p.name = typeof d.p?.n === 'string' && NAME_RE.test(d.p.n) ? d.p.n : '旅人';
  p.look = d.p.look && typeof d.p.look === 'object' ? d.p.look : null;
  const l = clamp(d.l, 0, cfg.lanes - 1) ?? 0;
  let target = lane(room, l);
  if (target.map.size >= cfg.maxPlayers) {
    let found = null;
    for (let i = 0; i < cfg.lanes; i++) if ((rooms.get(room)?.[i]?.size ?? 0) < cfg.maxPlayers) { found = lane(room, i); break; }
    if (!found) { send(p.ws, { t: 'err', code: 'full' }); return; }
    target = found;
  }
  p.room = target.room; p.laneL = target.l;
  target.map.set(p.id, p);
  players.set(p.id, p);
  pending.delete(p.tok);
  p.joined = true;
  send(p.ws, { t: 'welcome', pid: p.id, tok: p.tok, room: p.room, lane: p.laneL, players: rosterOf(target.map) });
  broadcastAll(target.map, { t: 'roster', players: rosterOf(target.map) });
}

function handleNv(p, d) {
  if (!guard(p, d)) return;
  const lm = rooms.get(p.room)?.[p.laneL];
  if (!lm) return;
  broadcastExcept(lm, p.id, {
    t: 'nv', l: [{ p: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), Y: +p.Y.toFixed(3), a: p.a }],
  });
}

function handleChat(p, d) {
  const t = now();
  if (t - p.lastChat < 1000 / cfg.chatRate) return;
  p.lastChat = t;
  const m = typeof d.m === 'string' ? d.m.slice(0, 120).replace(/[\u0000-\u001f<>]/g, '') : '';
  if (!m) return;
  const lm = rooms.get(p.room)?.[p.laneL];
  if (lm) broadcastAll(lm, { t: 'msg', p: p.id, n: p.name, m });
}

function removeFromRoom(p) {
  const lm = rooms.get(p.room)?.[p.laneL];
  if (lm && lm.has(p.id)) {
    lm.delete(p.id);
    broadcastAll(lm, { t: 'gone', p: p.id });
    for (const lms of rooms.values()) for (let i = lms.length - 1; i >= 0; i--) if (lms[i] && lms[i].size === 0) lms.splice(i, 1);
    if (lm.size === 0) rooms.delete(p.room);
  }
}

function handleLeave(p) {
  removeFromRoom(p);
  players.delete(p.id);
  p.joined = false;
}

// ---------------------------------------------------------------- ws
const handler = {
  open(ws) {
    ws.data.helloAt = now();
    ws.data.ws = ws;
    live.add(ws.data);
    byIp.set(ws.data.ip, (byIp.get(ws.data.ip) || 0) + 1);
  },
  message(ws, raw) {
    const st = ws.data;
    stats.msgIn++;
    if (typeof raw === 'string' ? raw.length > cfg.msgMaxBytes : raw?.byteLength > cfg.msgMaxBytes) {
      stats.drops++;
      try { ws.close(1009, 'too large'); } catch {}
      return;
    }
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    let p = st.player;
    if (d.t === 'hello') {
      if (p) return; // 已在连：忽略重复握手，避免刷出无主槽位
      p = new Player(ws, genId(), typeof d.tok === 'string' && /^[0-9a-f]{16,24}$/.test(d.tok) ? d.tok : genTok());
      st.player = p;
      st.joined = false;
      pending.set(p.tok, p);
      send(ws, { t: 'hello', pid: p.id, tok: p.tok });
      return;
    }
    if (!p || p.ws !== ws) return;
    try {
      switch (d.t) {
        case 'ping': st.joined = p.joined; send(ws, { t: 'pong', ts: d.ts }); break;
        case 'join': if (!p.joined) { handleJoin(p, d); st.joined = p.joined; } break;
        case 'st': if (p.joined) handleNv(p, d); break;
        case 'ch': if (p.joined) handleChat(p, d); break;
        case 'leave': handleLeave(p); st.joined = false; break;
      }
    } catch (e) { console.error('[handler]', d.t, e.message); } // 单帧异常不断连
  },
  close(ws) {
    live.delete(ws.data);
    const ip = ws.data.ip;
    if (ip && byIp.has(ip)) byIp.set(ip, Math.max(0, (byIp.get(ip) || 1) - 1));
    const p = ws.data.player;
    if (p?.joined) handleLeave(p);
  },
  drain(ws) { /* 发送缓冲满：状态帧幂等，丢旧留新即可，无需处理 */ },
};

// ---------------------------------------------------------------- 回收与统计
setInterval(() => {
  const t = now();
  for (const st of live) {
    if (!st.player && t - st.helloAt > cfg.idleKillMs) { try { st.ws?.close?.(1011, 'idle'); } catch {} live.delete(st); }
  }
  for (const [tok, p] of pending) {
    if (t - p.lastIn > cfg.slotTtlMs) { pending.delete(tok); try { p.ws?.close?.(1011, 'slot expired'); } catch {} }
  }
}, 5000).unref?.();

setInterval(() => {
  const up = Math.round((now() - stats.startedAt) / 1000);
  const ips = Object.entries(byIp).filter(([, c]) => c > 0).length;
  log(`[stats] up=${up}s online=${players.size} conns=${live.size} ips=${ips} in/s=${stats.msgIn} drops=${stats.drops} rej=${stats.rejected}`);
  stats.msgIn = 0;
}, 30000).unref?.();

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const SAFE_PATH = /^(\/[\w.\-]+)*$/;
const gzipCache = new Map(); // path -> { etag, body }

async function staticResponse(path, req) {
  const file = Bun.file(cfg.root + path);
  if (!(await file.exists())) return null;
  const type = MIME[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream';
  const mtime = await file.lastModified; // Bun 中为数值，跨版本 await 兼容
  const etag = 'W/"' + file.size.toString(36) + '-' + Number(mtime).toString(36) + '"';
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  const wantsGzip = /\bgzip\b/.test(req.headers.get('accept-encoding') || '');
  const headers = { 'content-type': type, etag, 'cache-control': 'public, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' };
  if (wantsGzip) {
    let c = gzipCache.get(path);
    if (!c || c.etag !== etag) { c = { etag, body: Bun.gzipSync(new Uint8Array(await file.arrayBuffer())) }; gzipCache.set(path, c); }
    return new Response(c.body, { headers: { ...headers, 'content-encoding': 'gzip' } });
  }
  return new Response(file, { headers });
}

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  tls: cfg.tlsCert ? { cert: Bun.file(cfg.tlsCert), key: Bun.file(cfg.tlsKey) } : undefined,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const ip = clientIp(req, server);
      const used = byIp.get(ip) || 0;
      if (live.size >= cfg.maxConns || used >= cfg.maxPerIp) {
        stats.rejected++;
        return new Response('server busy', { status: 503, headers: { 'retry-after': '5', 'x-content-type-options': 'nosniff' } });
      }
      if (!server.upgrade(req, { data: { ip, player: null, joined: false, helloAt: 0, ws: null } })) {
        return new Response('upgrade required', { status: 426 });
      }
      return;
    }
    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true, version: 1, online: players.size, rooms: rooms.size, conns: live.size,
        uptime_s: Math.round((now() - stats.startedAt) / 1000), tls: !!cfg.tlsCert,
      });
    }
    if (url.pathname === '/rooms') {
      const list = [];
      for (const [name, lms] of rooms)
        lms.forEach((m, l) => list.push({
          r: name, l, on: [...m.values()].filter((p) => p.joined).length,
          members: [...m.values()].map((p) => ({ id: p.id, n: p.name, j: p.joined, x: p.x, z: p.z, ban: now() < p.bannedUntil })),
        }));
      return Response.json({ rooms: list, max: cfg.maxPlayers, lanes: cfg.lanes });
    }
    if (url.pathname === '/metrics') {
      return Response.json({ online: players.size, conns: live.size, drops: stats.drops, rejected: stats.rejected, msg_out: stats.msgOut, uptime_s: Math.round((now() - stats.startedAt) / 1000) });
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!SAFE_PATH.test(path)) return new Response('bad path', { status: 400, headers: { 'x-content-type-options': 'nosniff' } });
    if (!/\.(html|js|json|css)$/.test(path)) return new Response('not found', { status: 404, headers: { 'x-content-type-options': 'nosniff' } });
    const res = await staticResponse(path, req);
    return res || new Response('not found', { status: 404, headers: { 'x-content-type-options': 'nosniff' } });
  },
  websocket: { ...handler, maxPayloadLength: cfg.msgMaxBytes },
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  log(`[server] ${sig} → 关闭 ${live.size} 条连接`);
  for (const st of live) { try { st.ws?.close?.(1001, 'restart'); } catch {} }
  try { server.close(true); } catch {}
  setTimeout(() => process.exit(0), 300).unref?.();
  process.exit(0);
}

function lanIps() {
  const out = [];
  for (const list of Object.values(networkInterfaces()))
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
}
const ips = lanIps();
log(`[星屑物语] 多人服务端已启动 (bun ${Bun.version})`);
log(`  本机    ${httpScheme}://localhost:${cfg.port}`);
for (const ip of ips) log(`  局域网  ${httpScheme}://${ip}:${cfg.port}`);
log(`  联机端点 ${wsScheme}://<公网IP或域名>:${cfg.port}/ws`);
log(`  健康检查 ${httpScheme}://127.0.0.1:${cfg.port}/healthz`);
log(`  容量     ${cfg.lanes} 分线 × ${cfg.maxPlayers} 人 · 在连上限 ${cfg.maxConns} · 单 IP ${cfg.maxPerIp}`);
if (!cfg.tlsCert) log('  提示     无 TLS：浏览器以 https 页面访问时需前置反代或设 TLS_CERT/TLS_KEY');
