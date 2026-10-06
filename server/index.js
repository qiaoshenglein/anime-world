// 星屑物语 · 多人联机服务端
// 本机: bun server/index.js            公网: bash deploy/start.sh   （详见 docs/deploy.md）
// 协议与设计: docs/server-design.md
import { networkInterfaces } from 'node:os';
import { writeFileSync } from 'node:fs';
import { openDb, Store } from './db.js';
import { Auth, NAME_RE, parseCookie, cookieSet, cookieKill, jsonBody, json, COOKIE } from './auth.js';
import { WEATHER, shardGem, wishGem } from './weather.js';

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
  kingHp: Number(env.KING_HP || 60),           // 史莱姆王权威血量（每条分线各一只，多人一起磨）
  kingHit: Number(env.KING_HIT || 8),          // 单跳封顶伤害：改内存里的伤害数字秒杀失效
  tideMs: Number(env.TIDE_MS || 150000),       // 一波潮压下去之后，下一波最早什么时候再来
  tideHp: Number(env.TIDE_HP || 40),           // 波的血量池（每条分线一份），两人以上才开潮
  tideHit: Number(env.TIDE_HIT || 8),          // 单跳进池封顶：和王的规矩一致，改不了池子就刷不动波
  tideGem: Number(env.TIDE_GEM || 5),          // 压下一波，全线每人分几枚星尘
  duetMs: Number(env.DUET_MS || 90000),        // 合奏的冷却：同一对人再合也得等这么久才发钱
  duetGem: Number(env.DUET_GEM || 1),          // 一次合奏每人几枚星尘
  duetDist: Number(env.DUET_DIST || 9),        // 两个人要多近才算「站在同一处」
  dbFile: env.AW_DB || '',                     // 账号/进度/世界/石碑库文件，留空=内存模式
  portFile: env.AW_PORT_FILE || '',            // 测试用：PORT=0 时把真实端口写进这里
  root: new URL('..', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1'),
};
const wsScheme = cfg.tlsCert ? 'wss' : 'ws';
const httpScheme = cfg.tlsCert ? 'https' : 'http';

const opened = openDb(cfg.dbFile);      // 打不开就退回内存模式，联机不受影响
const store = new Store(opened.db);
const auth = new Auth(store);
const dbMode = opened.mode;

const rooms = new Map();    // room -> [lane0, lane1...]，lane = Map<playerId, Player>
const players = new Map();  // playerId -> Player
const pending = new Map();  // token -> Player（握手后未入房的槽位，超时回收）
const live = new Set();     // {ws, ip, helloAt, joined} 在连记录
const byIp = new Map();     // ip -> count
const stats = { msgIn: 0, msgOut: 0, drops: 0, rejected: 0, pvpRej: 0, resync: 0, wRej: 0, tRej: 0, kRej: 0, lRej: 0, gRej: 0, cRej: 0, fRej: 0, bRej: 0, tideRej: 0, duets: 0, dRej: 0, startedAt: Date.now() };

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
  for (const p of laneMap.values()) if (p.id !== fromPid && p.joined && !p.blocked(obj.u, obj.own)) { try { p.ws.send(s); } catch {} }
}
function broadcastAll(laneMap, obj) {
  const s = JSON.stringify(obj);
  stats.msgOut++;
  for (const p of laneMap.values()) if (p.joined && !p.blocked(obj.u, obj.own)) { try { p.ws.send(s); } catch {} }
}
const rosterOf = (laneMap) => [...laneMap.values()].filter((p) => p.joined).map((p) => p.public());

// ---------------------------------------------------------------- player
class Player {
  constructor(ws, id, tok, who, ip) {
    this.ws = ws; this.id = id; this.tok = tok;
    this.acct = who?.account || null;   // 无 cookie 的临时连接照样能玩，只是没有任何持久化
    this.name = who?.name || '旅人'; this.look = null; this.joined = false;
    this.room = 'sakura'; this.laneL = 0;
    this.x = 0; this.y = 2; this.z = 16; this.Y = Math.PI;
    this.a = { sp: 0, glid: 0, sw: 0, air: 0, jmp: 0, hit: 0, dead: 0 };
    this.ts = now(); this.lastIn = now(); this.lastChat = 0; this.msgBudget = cfg.msgRate;
    this.bannedUntil = 0;
    this.pvp = false; this.lastPk = 0; this.lastEm = 0; this.lastPing = 0;
    this.echo = null; this.lastDuet = 0;   // 合奏用：身上那一声还没被回应的动作，以及上一次领钱的时间
    this.lastBoard = 0; this.lastLike = 0;
    this.ip = ip || 'unknown';   // 匿名连接也要有 IP，否则封 IP 会被丢掉 cookie 绕过
    this.mutes = this.acct ? store.mutes(this.acct) : new Set();
    this.prog = this.acct ? store.progress(this.acct) : null;
  }
  // 静音只屏蔽「社交信号」（说话/动作/呼叫/留言），不抹掉人在世界里的存在
  blocked(byAcct, owner) { return (!!byAcct && this.mutes.has(byAcct)) || (!!owner && this.mutes.has(owner)); }
  key() { return this.acct || this.id; }
  save() {
    if (!this.acct || !this.prog) return;
    store.saveProgress(this.acct, this.prog);
    store.saveLook(this.acct, this.look, this.laneL);
  }
  public() {
    // u = 账号 id（静音/举报要按人不是按连接）；a 留给动画状态位
    return { p: this.id, n: this.name, u: this.acct, look: this.look, pv: this.pvp ? 1 : 0, x: +this.x.toFixed(2), y: +this.y.toFixed(2), z: +this.z.toFixed(2), Y: +this.Y.toFixed(3), a: this.a };
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
  if (dist > cfg.speedLimit * dt + 8) {
    // 客户端存在合法瞬移（死亡重生、掉出世界、剧情传送），也可能是重连后落到新 Player 的默认坐标。
    // 一味丢弃会让该玩家对所有人永久定格在旧位置（表现为“看不到同伴/同伴看不到我”），
    // 因此连续 3 帧被拒或客户端自报 rs 时，放行一次重同步（1.2s 节流，作弊者最多 1.2s 挪一次）。
    stats.drops++;
    p.rej = (p.rej || 0) + 1;
    const mayRs = t - (p.lastRs || 0) > 1200 && (d.rs || p.rej >= 3);
    if (!mayRs) return false;
    p.lastRs = t; p.rej = 0; stats.resync++;
  } else p.rej = 0;
  p.x = x; p.y = y; p.z = z; p.Y = Y;
  const a = d.a || {};
  p.a = { sp: +num(a.sp, 0, 25).toFixed(1), glid: a.glid ? 1 : 0, sw: a.sw ? 1 : 0, air: a.air ? 1 : 0, jmp: a.jmp ? 1 : 0, hit: a.hit ? 1 : 0, dead: a.dead ? 1 : 0 };
  return true;
}

// ---------------------------------------------------------------- handlers
function handleJoin(p, d) {
  const room = typeof d.r === 'string' && /^[a-z]{3,16}$/.test(d.r) ? d.r : 'sakura';
  const nm = typeof d.p?.n === 'string' && NAME_RE.test(d.p.n) ? d.p.n : null;
  const bi = store.bannedIp(p.ip);
  if (bi) { send(p.ws, { t: 'err', code: 'banned', until: bi.until }); stats.rejected++; log(`[ban] IP ${p.ip} 被封至 ${bi.until}`); return; }
  if (p.acct) {
    store.noteIp(p.acct, p.ip);
    const b = store.banned(p.acct);
    if (b) { send(p.ws, { t: 'err', code: 'banned', until: b.until }); stats.rejected++; log(`[ban] ${p.acct} 于 ${b.until} 前被封（${b.reason || '无备注'}）`); return; }
    const a = store.acct(p.acct);
    p.name = (a && a.name) || nm || '旅人';        // 绑过号的旅人以档案里的名字为准
    if (a && !a.name && nm) store.setName(p.acct, nm);
    if (a) p.laneL = a.lane || 0;
  } else if (nm) p.name = nm;
  // 换装跟着「账号」走而不是跟着「设备」走：换台机器登录也该穿同一身衣服
  p.look = (p.acct && store.acct(p.acct)?.look) || cleanLook(d.p.look);
  const l = clamp(d.l, 0, cfg.lanes - 1) ?? p.laneL;
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
  const w = worldOf(p.room, p.laneL);
  if (p.acct) { store.bumpPlays(p.acct); if (!p.prog) p.prog = store.progress(p.acct) || { stage: 0, k0: 0, shards: 0, kills: 0, deaths: 0, plays: 1, wish: 0, upgraded: 0, gem: 0, gear: {}, codex: {} }; }
  send(p.ws, {
    t: 'welcome', pid: p.id, tok: p.tok, room: p.room, lane: p.laneL, pv: p.pvp ? 1 : 0,
    me: p.acct ? { a: p.acct, n: p.name, bound: store.credential(p.acct)?.kind === 'bound' } : null,
    prog: p.prog || null, pvp: p.acct ? store.pvpToday(p.acct) : null,
    look: p.look || null,
    gear: GEAR, gemCost: GEAR_KILL_GEM,
    world: worldMsg(w), shards: shardListMsg(p.room, p.laneL), boards: boardList(p.room, p.laneL),
    players: rosterOf(target.map),
  });
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
  if (lm) broadcastAll(lm, { t: 'msg', p: p.id, n: p.name, u: p.acct || '', m });
}

function removeFromRoom(p) {
  const lms = rooms.get(p.room);
  const lm = lms?.[p.laneL];
  if (lm && lm.has(p.id)) {
    lm.delete(p.id);
    broadcastAll(lm, { t: 'gone', p: p.id });
  }
  // 只有整条房间全空才删除；空 lane 必须原地保留占位——
  // 一旦 splice 掉空 lane，后面的 lane 索引整体前移，所有玩家的 laneL 就指错了线（人会集体失联）
  if (lms && lms.every((m) => !m || m.size === 0)) rooms.delete(p.room);
}

// ---------------------------------------------------------------- 玩家间交互
const EMOTES = ['wave', 'heart', 'up', 'spark', 'bow', 'dance'];
const DUET_WINDOW = 3000;   // 合奏的「回响」窗口：表情自己隔 1.5s 一下，这里允许三秒内被接住

function handlePvp(p, d) {
  p.pvp = !!d.v;
  const lm = rooms.get(p.room)?.[p.laneL];
  if (lm) broadcastAll(lm, { t: 'pv', p: p.id, v: p.pvp ? 1 : 0 });
}

function handleEmote(p, d) {
  const e = EMOTES.includes(d.e) ? d.e : null;
  if (!e) return;
  const t = now();
  if (t - p.lastEm < 1500) return;
  p.lastEm = t;
  const lm = rooms.get(p.room)?.[p.laneL];
  if (!lm) return;
  broadcastExcept(lm, p.id, { t: 'em', p: p.id, e, u: p.acct || '' });
  // 合奏：同一个动作在三秒内被两个人做出来，而且两个人真站在同一处。
  // 上行还是那条 em，服务端只是多看了一眼时间戳与距离——这个玩法几乎不占带宽，钱照样由这里发。
  const mate = pickDuetMate(p, e, lm, t);
  if (!mate) { p.echo = { e, t }; return; }
  p.echo = null; mate.echo = null;
  stats.duets++;
  const x = Math.round(p.x), z = Math.round(p.z);
  broadcastAll(lm, { t: 'du', a: p.id, b: mate.id, na: p.name, nb: mate.name, e, x, z, g: cfg.duetGem });
  duetCredit(p, cfg.duetGem, t);
  duetCredit(mate, cfg.duetGem, t);
  log(`[duet] ${p.room}:${p.laneL} ${p.name} 与 ${mate.name} 合奏了一个 ${e}`);
}

// 只找「身上带着没被回应的那一声」的人：配上就两边一起清空，第三个人不会把同一声回响接走。
// 冷却没过的人仍然可以被配上动作，只是不发钱——想刷就刷不出星尘。
function pickDuetMate(p, e, lm, t) {
  let best = null, bestD = Infinity;
  for (const q of lm.values()) {
    if (q === p || !q.joined) continue;
    if (q.acct && q.acct === p.acct) continue;      // 同一个账号开两个窗不算两个人
    if (!q.echo || q.echo.e !== e || t - q.echo.t > DUET_WINDOW) continue;
    const dist = Math.hypot(p.x - q.x, p.z - q.z);
    if (dist > cfg.duetDist) continue;              // 距离归服务端的位置帧说，客户端报不了你在哪
    if (t - (q.lastDuet || 0) < cfg.duetMs) { stats.dRej++; continue; }
    if (dist < bestD) { best = q; bestD = dist; }
  }
  return best;
}

function duetCredit(p, gem, t) {
  p.lastDuet = t;
  if (!p.acct || !p.prog) return;   // 没身份的 connection 照样看烟花，只是没有账本可记
  p.prog.gem = (p.prog.gem | 0) + gem;
  store.saveProgress(p.acct, p.prog);
  tellProg(p);
}

// 切磋：双方都须开启；伤害与距离由服务端裁决，命中结果广播给全线
// 每条被拒的原因都计入 stats.pvpRej，便于排查「为什么我的攻击没有伤害」
function rejectPvp() { stats.pvpRej++; }
function handlePvpHit(p, d) {
  const t = now();
  if (!p.pvp) return rejectPvp();
  if (t - p.lastPk < 300) return;
  const target = players.get(d.k);
  if (!target || !target.joined || target === p || target.room !== p.room || target.laneL !== p.laneL) return rejectPvp();
  if (!target.pvp) return rejectPvp();
  const dist = Math.hypot(p.x - target.x, p.z - target.z);
  if (dist > 6) return rejectPvp();
  const dmg = Math.round(num(d.d, 1, 24));
  p.lastPk = t;
  if (p.acct) store.addPvp(p.acct, 1, dmg, false);
  // d 必须显式赋值为结算后的伤害：入站参数同名，写成 `{ d }` 会把整个请求对象转发出去
  broadcastAll(rooms.get(p.room)[p.laneL], {
    t: 'pk', a: p.id, s: target.id, d: dmg, x: +p.x.toFixed(1), z: +p.z.toFixed(1),
  });
}

function handlePing(p, d) {
  const x = clamp(d.x, -420, 420), z = clamp(d.z, -420, 420);
  if (x == null || z == null) return;
  const t = now();
  if (t - p.lastPing < 2500) return;
  p.lastPing = t;
  const lm = rooms.get(p.room)?.[p.laneL];
  if (lm) broadcastExcept(lm, p.id, { t: 'pg', p: p.id, n: p.name, u: p.acct || '', x: +x.toFixed(1), z: +z.toFixed(1) });
}

// 烟花是给整条分线看的：一个人放一次，八秒冷却，位置取整防抖
function handleFirework(p, d) {
  const t = now();
  if (t - (p.lastFw || 0) < 8000) { stats.fRej++; return; }
  p.lastFw = t;
  const x = Math.round(clamp(num(d.x, -420, 420), -420, 420)), z = Math.round(clamp(num(d.z, -420, 420), -420, 420));
  const lm = rooms.get(p.room)?.[p.laneL];
  if (lm) broadcastExcept(lm, p.id, { t: 'fw', p: p.id, n: p.name, x, z });
}

// 星屑弹是纯演出：服务端只转发「谁朝哪儿放了多满的一发」，伤害一分也不认。
// 怪物本来就在每个人自己的客户端里模拟，王的血量另有 kb 通道封顶，所以这里只需限流。
function handleBolt(p, d) {
  const t = now();
  if (t - (p.lastBo || 0) < 350) { stats.bRej++; return; }
  p.lastBo = t;
  const lm = rooms.get(p.room)?.[p.laneL];
  if (lm) broadcastExcept(lm, p.id, { t: 'bo', p: p.id, c: +num(d.c, 0, 1).toFixed(2), Y: +num(d.Y, -7, 7).toFixed(3) });
}

// ---------------------------------------------------------------- 世界状态（服务端权威，每条分线一份）
// 权威的是「结果」而不是逐帧模拟：任务阶段只能一格一格往前、碎片同线只算一次、
// Boss 血量由服务端累计并限流。客户端照样本地预测手感，显示以这里下发的快照为准。
const KING_RESPAWN_MS = 240000;
// 天气归这一条分线所有：同一片天空下的人看见同一场雨，别条线晴不晴与你无关。
// 由服务端按时辰轮转并随快照下发，客户端没有「改天气」的入口——省得有人拿天气捣乱。
// 天不只换风景，也换规则：那张表在 weather.js（雨里的星屑更润、流星夜的愿望有人听见…）。
const WEATHER_MS = Number(env.WEATHER_MS || 240000);
// 演示服或回归测试要把天空钉住时用 WEATHER_PIN=<clear|petal|rain|fog|meteor>（给不出这个名字就照常轮转）
const WEATHER_PIN = WEATHER.indexOf(env.WEATHER_PIN || '');
// 成长树：定义只写在这一处，随 welcome 下发给客户端渲染，价格永远不会前后端说两套话
const GEAR = {
  vit: { name: '体魄', max: 3, cost: [4, 9, 16], desc: ['生命上限 125', '生命上限 150', '生命上限 175'] },
  jump: { name: '弹跳', max: 3, cost: [3, 8, 15], desc: ['起跳更有力', '空中的第二跳更有力', '落地前还能再跳一次'] },
  glide: { name: '滑翔', max: 3, cost: [3, 7, 13], desc: ['滑翔耗体力 -18%', '滑翔耗体力 -35%', '滑翔耗体力 -50%'] },
  dmg: { name: '剑伤', max: 3, cost: [5, 11, 20], desc: ['挥剑伤害 +1', '挥剑伤害 +2', '挥剑伤害 +3'] },
  shot: { name: '星射', max: 3, cost: [4, 10, 18], desc: ['星屑弹伤害 +1', '蓄力更快，满蓄可穿透两个目标', '伤害再 +1，满蓄可穿透三个目标'] },
};
const GEAR_KILL_GEM = 4;   // 击败史莱姆王的奖赏（星尘）
const STAMP_GEM = 2;       // 第一次踏上某处景点
const CODEX_CAP = 80;      // 一个人最多能记下的景点/成就数
const LOOK_KEYS = ['hair', 'eye', 'top', 'skirt', 'accent', 'scarf'];
const LOOK_STYLE = ['twin', 'pony', 'short', 'long', 'bun'];
const LOOK_ACC = ['hat', 'ears', 'halo', 'staff', 'apron'];
// 外观是给别人看的，字段与颜色都得先过一遍：不能塞任意对象进广播（键名与客户端 lookFor/buildCharacter 一致）
const cleanLook = (o) => {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of LOOK_KEYS) if (typeof o[k] === 'number' && isFinite(o[k])) out[k] = Math.max(0, Math.min(0xffffff, Math.round(o[k])));
  if (LOOK_STYLE.includes(o.style)) out.style = o.style;
  if (Array.isArray(o.acc)) out.acc = o.acc.filter((x) => typeof x === 'string' && LOOK_ACC.includes(x)).slice(0, 2);
  return Object.keys(out).length ? out : null;
};
const MAX_STAGE = 8, MAX_K0 = 8, MAX_WISH = 9, MAX_SHARDS = Number(env.MAX_SHARDS || 60);
const worlds = new Map();  // 'room:lane' -> {stage,k0,kingHp,kingAlive,wish,upgraded,respawnAt,dirty}
const shards = new Map();  // 'room:lane' -> Set('x,z')
const wkey = (room, l) => room + ':' + l;

function worldOf(room, l) {
  const k = wkey(room, l);
  let w = worlds.get(k);
  if (w) return w;
  const r = store.world(room, l);
  w = {
    stage: r.stage | 0, k0: r.k0 | 0, wish: r.wish | 0, upgraded: !!r.upgraded,
    kingAlive: !!r.king_alive, kingHp: r.king_alive ? (r.king_hp || cfg.kingHp) : 0,
    respawnAt: r.king_alive ? 0 : now() + KING_RESPAWN_MS,
    weather: WEATHER_PIN >= 0 ? WEATHER_PIN : (WEATHER[r.weather | 0] ? (r.weather | 0) : 0), weatherAt: now() + WEATHER_MS, dirty: false,
    // 潮要两个人在场才开，池子只活在这条分线的当下（重启就等于这一波散了，别让人追着半个池子打）。
    // 第一波也要等一个间隔：两个刚碰面的旅人不该被立刻包围。
    tideRound: r.tide_round | 0, tideAlive: false, tideHp: 0, tideMax: 0, tideNextAt: now() + cfg.tideMs,
  };
  worlds.set(k, w);
  if (!shards.has(k)) shards.set(k, new Set(store.shardList(room, l).map((x) => x.x + ',' + x.z)));
  return w;
}
// 快照字段名不能与消息类型 t 同名，也不能用展开合并带 t 的实体
const worldMsg = (w) => ({
  t: 'ws', st: w.stage, k0: w.k0, ka: w.kingAlive ? 1 : 0, kh: w.kingHp, km: cfg.kingHp, wi: w.wish, up: w.upgraded ? 1 : 0, we: w.weather,
  tr: w.tideRound, ta: w.tideAlive ? 1 : 0, th: w.tideHp, tm: w.tideMax,
});
function flushWorld(room, l, w) {
  store.saveWorld(room, l, { stage: w.stage, k0: w.k0, king_hp: w.kingHp, king_alive: w.kingAlive ? 1 : 0, wish: w.wish, upgraded: w.upgraded ? 1 : 0, weather: w.weather, tide_round: w.tideRound });
  const lm = rooms.get(room)?.[l];
  if (lm) broadcastAll(lm, worldMsg(w));
}
// 个人档案只在变化时回给本人：面板上的碎片/击败数才不会停在进房那一刻
const tellProg = (p) => { if (p.acct && p.prog) send(p.ws, { t: 'pr', prog: p.prog }); };
const markWorld = (p) => { p.wc = worldOf(p.room, p.laneL); p.wc.dirty = true; };

function handleQuest(p, d) {
  const w = worldOf(p.room, p.laneL);
  const st = clamp(d.st, 0, MAX_STAGE), k0 = clamp(d.k0, 0, MAX_K0), wi = clamp(d.wi, 0, MAX_WISH);
  let ch = false, wished = false;
  if (st != null && st > w.stage && st <= w.stage + 1) { w.stage = st; ch = true; }      // 不许跳格、不许回退
  if (k0 != null && k0 > w.k0 && k0 <= w.k0 + 1) { w.k0 = k0; ch = true; }
  if (wi != null && wi > w.wish && wi <= w.wish + 1) { w.wish = wi; ch = true; wished = true; }
  if (d.up && !w.upgraded) { w.upgraded = true; ch = true; }
  // 倒下次数只记在个人档案上，不改动同一条分线的世界
  if (d.de && p.prog) {
    p.prog.deaths = (p.prog.deaths | 0) + 1;
    if (p.acct) store.saveProgress(p.acct, p.prog);
    if (!ch) return;
  }
  if (!ch) { stats.wRej++; return; }
  if (p.prog) {
    p.prog.stage = Math.max(p.prog.stage | 0, w.stage);
    p.prog.wish = Math.max(p.prog.wish | 0, w.wish);
    // 流星夜许的愿有人多听一句：这一份由记账的这边发，客户端只负责说一声
    if (wished) p.prog.gem = (p.prog.gem | 0) + wishGem(w.weather);
    if (w.upgraded) p.prog.upgraded = 1;
    if (p.acct) store.saveProgress(p.acct, p.prog);
    tellProg(p);
  }
  w.dirty = true;
}

function handleTake(p, d) {
  const x = Math.round(clamp(d.x, -420, 420)), z = Math.round(clamp(d.z, -420, 420));
  if (x == null || z == null) return;
  const t = now();
  if (t - (p.lastTake || 0) < 400) return;
  p.lastTake = t;
  if (Math.hypot(x - p.x, z - p.z) > 12) { stats.tRej++; return; }   // 人必须在现场，隔空捡碎片失效
  const w = worldOf(p.room, p.laneL);
  const set = shards.get(wkey(p.room, p.laneL));
  const id = x + ',' + z;
  if (set.has(id) || set.size >= MAX_SHARDS) { stats.tRej++; return; }
  if (!store.takeShard(p.room, p.laneL, x, z, p.key())) { set.add(id); stats.tRej++; return; } // 库里早有记录（重启后内存空了）：修齐内存再拒
  set.add(id);
  if (p.prog) { p.prog.shards = (p.prog.shards | 0) + 1; p.prog.gem = (p.prog.gem | 0) + shardGem(w.weather); if (p.acct) { store.saveProgress(p.acct, p.prog); tellProg(p); } }
  broadcastAll(rooms.get(p.room)[p.laneL], { t: 'sk', x, z, c: set.size, n: p.name });
}

// Boss 位置由客户端世界生成，服务端没法核对距离，改为限流：每人 0.2s 一跳、单跳封顶 KING_HIT
function handleKing(p, d) {
  const w = worldOf(p.room, p.laneL);
  if (!w.kingAlive) { stats.kRej++; return; }
  const t = now();
  if (t - (p.lastKb || 0) < 200) return;
  p.lastKb = t;
  w.kingHp = Math.max(0, w.kingHp - Math.round(num(d.d, 1, cfg.kingHit)));
  if (w.kingHp === 0) {
    w.kingAlive = false; w.respawnAt = t + KING_RESPAWN_MS;
    if (p.prog) {
      p.prog.kills = (p.prog.kills | 0) + 1;
      p.prog.gem = (p.prog.gem | 0) + GEAR_KILL_GEM;   // 王的一跳值得几枚星尘，鼓励同伴一起磨
      if (p.acct) { store.saveProgress(p.acct, p.prog); tellProg(p); }
    }
    log(`[king] ${p.room}:${p.laneL} 史莱姆王被 ${(p.prog && p.prog.kills) || ''} 位旅人击败`);
  }
  w.dirty = true;
}

const shardListMsg = (room, l) => [...(shards.get(wkey(room, l)) || worldOf(room, l) && shards.get(wkey(room, l)) || [])].map((s) => s.split(',').map(Number));

// ---------------------------------------------------------------- 史莱姆潮（协作事件，每条分线一份）
// 潮不是谁按的按钮，是这条分线自己涨上来的：至少两个人在场才开，池子按人头加，
// 压下去的星尘也按人头分。伤害进池子只认服务端这一份——每人 0.2s 一跳、单跳封顶 TIDE_HIT。
function lanePlayers(lm) { return lm ? [...lm.values()].filter((q) => q.joined) : []; }
function openTide(room, l, w, n) {
  w.tideAlive = true;
  w.tideMax = cfg.tideHp + Math.max(0, n - 2) * Math.round(cfg.tideHp * 0.6);
  w.tideHp = w.tideMax;
  w.dirty = true;
  log(`[tide] ${room}:${l} 第 ${w.tideRound + 1} 波涌起（${n} 人 · 池 ${w.tideMax}）`);
}
function handleTideHit(p, d) {
  const w = worldOf(p.room, p.laneL);
  if (!w.tideAlive) { stats.tideRej++; return; }
  const t = now();
  if (t - (p.lastTd || 0) < 200) return;
  p.lastTd = t;
  w.tideHp = Math.max(0, w.tideHp - Math.round(num(d.d, 1, cfg.tideHit)));
  w.dirty = true;
  if (w.tideHp > 0) return;
  w.tideAlive = false; w.tideRound++; w.tideNextAt = t + cfg.tideMs;
  const lm = rooms.get(p.room)?.[p.laneL];
  if (lm) {
    // 波是全线一起压下去的，奖励就不挑「谁打最后一下」：在场的有身份的人都记一份
    for (const q of lanePlayers(lm)) {
      if (!q.acct || !q.prog) continue;
      q.prog.gem = (q.prog.gem | 0) + cfg.tideGem;
      store.saveProgress(q.acct, q.prog);
      tellProg(q);
    }
    broadcastAll(lm, { t: 'td', r: w.tideRound, g: cfg.tideGem });
  }
  log(`[tide] ${p.room}:${p.laneL} 第 ${w.tideRound} 波被压下去`);
}

// 首次联网时把「这台设备单机攒下的成长」认作账号的起点：只在账号确实一片空白时接受，
// 上限就是整个世界能采到的量，所以既不会让人白丢进度，也刷不出多余的东西。
function handleClaim(p, d) {
  if (!p.acct || !p.prog) { stats.gRej++; return; }
  const g = (p.prog.gem | 0) === 0 && Object.keys(p.prog.gear || {}).length === 0;
  if (!g) return;
  p.prog.gem = num(d.gem, 0, MAX_SHARDS);
  const src = d.gear && typeof d.gear === 'object' ? d.gear : {};
  p.prog.gear = p.prog.gear || {};
  for (const k in GEAR) p.prog.gear[k] = num(src[k], 0, GEAR[k].max);
  // 景点是「去过」的纪念，认领时只搬记录、不再另发星尘——那枚星尘本来就在搬过来的余额里
  const cx = (p.prog.codex && p.prog.codex.stamps) ? p.prog.codex : { stamps: [] };
  for (const s of Array.isArray(d.stamps) ? d.stamps : []) {
    if (typeof s !== 'string' || !/^[a-z][a-z0-9_]{1,23}$/.test(s) || cx.stamps.includes(s) || cx.stamps.length >= CODEX_CAP) continue;
    cx.stamps.push(s);
  }
  p.prog.codex = cx;
  store.saveProgress(p.acct, p.prog);
  tellProg(p);
  log(`[gear] ${p.name} 认领了设备上的旧成长`);
}

// 景点打卡与成就：键由客户端的目录给出，服务端只认格式、限量、去重
function handleCodex(p, d) {
  if (!p.acct || !p.prog) { stats.cRej++; return; }
  const key = typeof d.s === 'string' ? d.s : '';
  if (!/^[a-z][a-z0-9_]{1,23}$/.test(key)) { stats.cRej++; return; }
  const t = now();
  if (t - (p.lastCodex || 0) < 600) return;
  const cx = p.prog.codex || (p.prog.codex = { stamps: [] });
  const list = cx.stamps || (cx.stamps = []);
  if (list.includes(key) || list.length >= CODEX_CAP) return;   // 记过了：静默，别把来回蹭地点变成刷星尘
  p.lastCodex = t;
  list.push(key);
  p.prog.gem = (p.prog.gem | 0) + STAMP_GEM;
  store.saveProgress(p.acct, p.prog);
  tellProg(p);
}

// 换装是穿给别人看的：当场广播给同线同伴，不必等下一次进房
function handleLook(p, d) {
  const look = cleanLook(d.look);
  if (!look) return;
  p.look = look;
  const lm = rooms.get(p.room)?.[p.laneL];
  if (lm) broadcastExcept(lm, p.id, { t: 'lk', p: p.id, look });
  if (p.acct) store.saveLook(p.acct, look, p.laneL);
}

// 星尘消费：余额与等级都只在这里变动，客户端报「想升哪一级」，能不能升由服务端算
function handleSpend(p, d) {
  const k = typeof d.k === 'string' ? d.k : '';
  const spec = GEAR[k];
  // 没有身份就没有可扣的余额：本地单机模式下客户端自己记账，这里只管拒绝
  if (!spec || !p.acct || !p.prog) { stats.gRej++; return; }
  const t = now();
  if (t - (p.lastSpend || 0) < 300) return;
  const lv = (p.prog.gear && p.prog.gear[k]) | 0;
  const cost = spec.cost[lv];
  if (lv >= spec.max || cost == null || (p.prog.gem | 0) < cost) { stats.gRej++; tellProg(p); return; }
  p.lastSpend = t;
  p.prog.gem = (p.prog.gem | 0) - cost;
  p.prog.gear = { ...p.prog.gear, [k]: lv + 1 };
  store.saveProgress(p.acct, p.prog);
  tellProg(p);
  log(`[gear] ${p.name} 的${spec.name}升到 ${lv + 1} 级`);
}

// ---------------------------------------------------------------- 留言石碑
// 一人一块、一句话，按账号存进库：主人下线、服务重启，话都还在原处。
const BOARD_CD = 8000;      // 同一人重刻间隔
const BOARD_NEAR = 14;      // 只能刻在自己脚下这么近的范围内
const BOARD_GAP = 3.6;      // 石碑之间不得叠在一起
const LIKE_CD = 4000;
const BOARD_CAP = 40;       // 每线最多保留的石碑
// 白名单式过滤：只留常见中日韩文字/数字/标点，控制字符、尖角括号与表情符号自然被挡掉
const BOARD_CH = /[一-鿿㐀-䶿　-〿A-Za-z0-9 ,.!?;:'\"()\[\]{}~—…·‘’“”、。！？：；（）\-]/;
const cleanBoard = (txt) => (typeof txt === 'string' ? txt : '')
  .split('').filter((ch) => BOARD_CH.test(ch)).join('').slice(0, 24).trim();
const boardMsg = (row) => ({ p: row.account, x: row.x, z: row.z, s: row.s, by: row.by_who, l: row.l });
const boardList = (room, l) => store.boardList(room, l).map(boardMsg);
// 广播里 t 是消息类型，只能显式列字段：把整块留言展开到 t 后面会把它覆盖掉（整条留言因此无人能收到）
const boardBcast = (row, u, own) => ({ t: 'mb', u, own, p: row.account, x: row.x, z: row.z, s: row.s, by: row.by_who, l: row.l });

function handleBoard(p, d) {
  const t = now();
  if (t - p.lastBoard < BOARD_CD) return;
  const s = cleanBoard(d.s);
  const x = clamp(d.x, -420, 420), z = clamp(d.z, -420, 420);
  if (!s || x == null || z == null) return;
  if (Math.hypot(x - p.x, z - p.z) > BOARD_NEAR) return;  // 站着不动刷满全图
  const mine = p.key();
  const rows = store.boardList(p.room, p.laneL);
  for (const row of rows) if (row.account !== mine && Math.hypot(row.x - x, row.z - z) < BOARD_GAP) return;
  if (!store.board(mine) && rows.length >= BOARD_CAP) return; // 满了就不再开新碑，重刻自己的不受影响
  p.lastBoard = t;
  store.putBoard(mine, p.room, p.laneL, +x.toFixed(1), +z.toFixed(1), s, p.name);
  broadcastAll(rooms.get(p.room)[p.laneL], boardBcast(store.board(mine), p.acct || '', mine));
}

function handleBoardClear(p) {
  if (!store.board(p.key())) return;
  store.dropBoard(p.key());
  broadcastAll(rooms.get(p.room)[p.laneL], { t: 'md', p: p.key() });
}

// 点赞是「本人不到场的互动」最便宜的一种：靠近才有、每人对同一作者每天只有一颗心
function handleBoardLike(p, d) {
  const t = now();
  if (t - p.lastLike < LIKE_CD) return;
  const owner = String(d.p || '');
  if (!owner || owner === p.key()) return;
  const row = store.board(owner);
  if (!row || row.room !== p.room || row.lane !== p.laneL) return;
  if (Math.hypot(row.x - p.x, row.z - p.z) > BOARD_NEAR) return;
  if (!store.markLiked(owner, p.key())) { stats.lRej++; return; }
  p.lastLike = t;
  broadcastAll(rooms.get(p.room)[p.laneL], boardBcast(store.board(owner), p.acct || '', owner));
}

function handleLeave(p) {
  p.save();
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
      p = new Player(ws, genId(), typeof d.tok === 'string' && /^[0-9a-f]{16,24}$/.test(d.tok) ? d.tok : genTok(), st.who, st.ip);
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
        case 'pv': if (p.joined) handlePvp(p, d); break;
        case 'em': if (p.joined) handleEmote(p, d); break;
        case 'pk': if (p.joined) handlePvpHit(p, d); break;
        case 'pg': if (p.joined) handlePing(p, d); break;
        case 'fw': if (p.joined) handleFirework(p, d); break;
        case 'bo': if (p.joined) handleBolt(p, d); break;
        case 'qs': if (p.joined) handleQuest(p, d); break;
        case 'tk': if (p.joined) handleTake(p, d); break;
        case 'kb': if (p.joined) handleKing(p, d); break;
        case 'th': if (p.joined) handleTideHit(p, d); break;
        case 'sp': if (p.joined) handleSpend(p, d); break;
        case 'sq': if (p.joined) handleClaim(p, d); break;
        case 'cd': if (p.joined) handleCodex(p, d); break;
        case 'lk': if (p.joined) handleLook(p, d); break;
        case 'mu': if (p.joined && p.acct) { d.on === false ? store.unmute(p.acct, String(d.u || '')) : store.mute(p.acct, String(d.u || '')); if (d.u) p.mutes = store.mutes(p.acct); } break;
        case 'rp': if (p.joined) store.report(String(d.u || d.p || ''), p.acct, typeof d.r === 'string' ? d.r : ''); break;
        case 'mb': if (p.joined) handleBoard(p, d); break;
        case 'mx': if (p.joined) handleBoardClear(p); break;
        case 'ml': if (p.joined) handleBoardLike(p, d); break;
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

// ---------------------------------------------------------------- 世界推进
// 脏标记 + 5Hz 合并下发：24 人一起打 Boss 也不会把这条线刷爆
setInterval(() => {
  const t = now();
  for (const [k, w] of worlds) {
    const ci = k.indexOf(':');
    const lm = rooms.get(k.slice(0, ci))?.[Number(k.slice(ci + 1))];
    if (!w.kingAlive && w.respawnAt && t >= w.respawnAt) {
      w.kingAlive = true; w.kingHp = cfg.kingHp; w.respawnAt = 0; w.dirty = true;
    }
    if (WEATHER_PIN < 0 && t >= w.weatherAt) {
      // 有人在看着才换、才落库：空分线的天空不必替谁记账
      if (lm && lm.size) {
        let n = w.weather;
        while (n === w.weather) n = Math.floor(Math.random() * WEATHER.length);
        w.weather = n; w.dirty = true;
      }
      w.weatherAt = t + WEATHER_MS;
    }
    // 潮要两个人以上才开：一个人时它是孤军，两个人时它才是协作
    const alone = lanePlayers(lm).length;
    if (!w.tideAlive && alone >= 2 && t >= (w.tideNextAt || 0)) openTide(k.slice(0, ci), Number(k.slice(ci + 1)), w, alone);
    if (!w.dirty) continue;
    w.dirty = false;
    flushWorld(k.slice(0, ci), Number(k.slice(ci + 1)), w);
  }
}, 200).unref?.();

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
  log(`[stats] up=${up}s online=${players.size} conns=${live.size} ips=${ips} in/s=${stats.msgIn} drops=${stats.drops} rej=${stats.rejected} pvp_rej=${stats.pvpRej} resync=${stats.resync} w_rej=${stats.wRej} take_rej=${stats.tRej} king_rej=${stats.kRej} like_rej=${stats.lRej} tide_rej=${stats.tideRej} tide=${[...worlds.values()].filter((w) => w.tideAlive).length} 波`);
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

// ---------------------------------------------------------------- 账号接口
// 全部只吃 application/json：跨站表单发不出这个 content-type，等于一道免费的 CSRF 门
async function apiResponse(req, path) {
  const ip = clientIp(req, server);
  const sid = parseCookie(req)[COOKIE];
  const who = auth.who(sid);
  try {
    if (path === '/api/me') {
      if (!who) return json({ bound: false, anon: true });
      const a = store.acct(who.account), pr = store.progress(who.account);
      return json({ anon: false, a: a.id, n: a.name, bound: a.kind === 'bound', prog: pr, pvp: store.pvpToday(a.id), mutes: [...store.mutes(a.id)] });
    }
    if (req.method !== 'POST') return json({ err: 'method' }, 405);
    if (path === '/api/guest') {
      if (who) return json({ a: who.account, n: who.name, bound: store.credential(who.account)?.kind === 'bound' }, 200); // 幂等：刷新页面不该又开一个号
      if (!auth.throttle(ip, 30)) return json({ err: 'busy' }, 429);
      const g = auth.guest();
      return json({ a: g.account, n: null, bound: false, fresh: true }, 200, { 'set-cookie': cookieSet(g.sid) });
    }
    const d = await jsonBody(req);
    if (path === '/api/login') {
      const r = await auth.login(d.n, String(d.p || ''), ip);
      if (r.err === 'locked') return json({ err: 'locked', retry: r.retry }, 429);
      if (r.err) return json({ err: 'bad' }, 401);
      if (store.banned(r.account)) return json({ err: 'banned' }, 403);
      return json({ a: r.account, n: r.name, bound: true }, 200, { 'set-cookie': cookieSet(r.sid) });
    }
    if (path === '/api/bind') {
      if (!who) return json({ err: 'anon' }, 401);
      if (!auth.throttle(ip, 10)) return json({ err: 'busy' }, 429);
      const r = await auth.bind(sid, d.n, String(d.p || ''));
      if (r.err === 'already' || r.err === 'taken') return json({ err: r.err }, 409);
      if (r.err) return json({ err: r.err }, 400); // name / taken / weak
      return json({ a: r.account, n: r.name, bound: true }, 200);
    }
    if (path === '/api/logout') {
      auth.logout(sid);
      return json({ ok: true }, 200, { 'set-cookie': cookieKill() });
    }
    return json({ err: 'not_found' }, 404);
  } catch (e) {
    if (!cfg.quiet) console.error('[api]', path, e.message);
    return json({ err: 'bad_request' }, 400); // 解析失败/超限/格式不对，一律不透露细节
  }
}

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  tls: cfg.tlsCert ? { cert: Bun.file(cfg.tlsCert), key: Bun.file(cfg.tlsKey) } : undefined,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const ip = clientIp(req, server);
      const who = auth.who(parseCookie(req)[COOKIE]);   // 没 cookie 也照常能玩，只是不落库
      const used = byIp.get(ip) || 0;
      if (live.size >= cfg.maxConns || used >= cfg.maxPerIp) {
        stats.rejected++;
        return new Response('server busy', { status: 503, headers: { 'retry-after': '5', 'x-content-type-options': 'nosniff' } });
      }
      if (!server.upgrade(req, { data: { ip, who, player: null, joined: false, helloAt: 0, ws: null } })) {
        return new Response('upgrade required', { status: 426 });
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) return apiResponse(req, url.pathname);
    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true, version: 1, online: players.size, rooms: rooms.size, conns: live.size,
        uptime_s: Math.round((now() - stats.startedAt) / 1000), tls: !!cfg.tlsCert,
        db: dbMode, db_file: cfg.dbFile || null, accounts: store.counts(),
      });
    }
    if (url.pathname === '/rooms') {
      const list = [];
      for (const [name, lms] of rooms)
        lms.forEach((m, l) => list.push({
          r: name, l, on: [...m.values()].filter((p) => p.joined).length,
          members: [...m.values()].map((p) => ({ id: p.id, n: p.name, j: p.joined, x: p.x, z: p.z, rej: p.rej || 0, ban: now() < p.bannedUntil })),
        }));
      return Response.json({ rooms: list, max: cfg.maxPlayers, lanes: cfg.lanes });
    }
    if (url.pathname === '/metrics') {
      return Response.json({ online: players.size, conns: live.size, tides: [...worlds.values()].filter((w) => w.tideAlive).length, drops: stats.drops, rejected: stats.rejected, pvp_rejected: stats.pvpRej, resync: stats.resync, world_rejected: stats.wRej, take_rejected: stats.tRej, king_rejected: stats.kRej, like_rejected: stats.lRej, gear_rejected: stats.gRej, codex_rejected: stats.cRej, firework_rejected: stats.fRej, bolt_rejected: stats.bRej, tide_rejected: stats.tideRej, duets: stats.duets, duet_rejected: stats.dRej, db: dbMode, msg_out: stats.msgOut, uptime_s: Math.round((now() - stats.startedAt) / 1000) });
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!SAFE_PATH.test(path)) return new Response('bad path', { status: 400, headers: { 'x-content-type-options': 'nosniff' } });
    if (!/\.(html|js|json|css)$/.test(path)) return new Response('not found', { status: 404, headers: { 'x-content-type-options': 'nosniff' } });
    const res = await staticResponse(path, req);
    return res || new Response('not found', { status: 404, headers: { 'x-content-type-options': 'nosniff' } });
  },
  websocket: { ...handler, maxPayloadLength: cfg.msgMaxBytes },
});

const boundPort = server.port;          // PORT=0 时由系统挑端口，横幅与测试都读真实值
if (cfg.portFile) { try { writeFileSync(cfg.portFile, String(boundPort)); } catch {} }

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
log(`  本机    ${httpScheme}://localhost:${boundPort}`);
for (const ip of ips) log(`  局域网  ${httpScheme}://${ip}:${boundPort}`);
log(`  联机端点 ${wsScheme}://<公网IP或域名>:${boundPort}/ws`);
log(`  健康检查 ${httpScheme}://127.0.0.1:${boundPort}/healthz`);
log(`  容量     ${cfg.lanes} 分线 × ${cfg.maxPlayers} 人 · 在连上限 ${cfg.maxConns} · 单 IP ${cfg.maxPerIp}`);
if (!cfg.tlsCert) log('  提示     无 TLS：浏览器以 https 页面访问时需前置反代或设 TLS_CERT/TLS_KEY');
