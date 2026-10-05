// P1 协议冒烟测试：bun test/net-smoke.mjs （需先起 server，或经 run-all 自动启动）
const URL = process.env.URL || 'ws://localhost:8770/ws';
const HTTP = URL.replace(/^ws/, 'http').replace(/\/ws\/?$/, '');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function ok(name, cond, extra) {
  log((cond ? '  ok  ' : ' FAIL  ') + name + (extra ? ' — ' + extra : ''));
  if (!cond) fails++;
}

function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  return {
    ws, inbox, name,
    until: async (pred, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const m = inbox.find(pred);
        if (m) { inbox.splice(inbox.indexOf(m), 1); return m; }
        await sleep(20);
      }
      throw new Error(name + ': timeout waiting for ' + pred.toString());
    },
    has: (pred) => !!inbox.find(pred),
    send: (o) => ws.send(JSON.stringify(o)),
  };
}

const a = client('A'), b = client('B');
await sleep(300);
a.send({ t: 'hello' });
b.send({ t: 'hello' });
const ha = await a.until((m) => m.t === 'hello'), hb = await b.until((m) => m.t === 'hello');
log('hello ok:', ha.pid, hb.pid);

a.send({ t: 'join', r: 'sakura', l: 0, p: { n: '小樱', look: { hair: 0xff0000 } } });
const wa = await a.until((m) => m.t === 'welcome');
log('welcome A ok, players:', wa.players.length, 'tok:', !!wa.tok);

b.send({ t: 'join', r: 'sakura', l: 0, p: { n: '阿澈' } });
const wb = await b.until((m) => m.t === 'welcome');
const seenA = await a.until((m) => m.t === 'roster' && m.players.some((p) => p.n === '阿澈'));
log('welcome B ok; A sees roster with', seenA.players.length, 'players');
ok('welcome 携带自身切磋开关', wa.pv === 0);
ok('roster 携带远端切磋开关', seenA.players.every((p) => 'pv' in p));

// 移动同步：正常移动应转发
a.send({ t: 'st', ts: Date.now(), x: 5, y: 2, z: 16, Y: 1.2, a: { sp: 6, glid: 0 } });
const nv = await b.until((m) => m.t === 'nv');
log('nv ok:', JSON.stringify(nv.l[0]));

// 瞬移作弊：应被丢弃（1.2s 内不应看到 300,300）
a.send({ t: 'st', ts: Date.now(), x: 300, y: 2, z: 300, Y: 0, a: {} });
await sleep(1200);
ok('瞬移帧被丢弃', !b.has((m) => m.t === 'nv' && m.l.some((s) => s.x > 200)));

// 聊天
a.send({ t: 'ch', m: '你好呀 <script>' });
const ch = await b.until((m) => m.t === 'msg');
log('chat ok:', ch.n, ch.m, '| sanitized:', !ch.m.includes('<'));

// ---------------------------------------------------------------- 玩家间交互
a.send({ t: 'pv', v: 1 });
const pvOn = await b.until((m) => m.t === 'pv' && m.p === ha.pid);
ok('切磋开关被广播', pvOn.v === 1);

a.send({ t: 'pk', k: hb.pid, d: 10 });
await sleep(400);
ok('对方未开启切磋时不结算伤害', !b.has((m) => m.t === 'pk'));

a.send({ t: 'em', e: 'wave' });
const em = await b.until((m) => m.t === 'em');
ok('表情转发', em.e === 'wave' && em.p === ha.pid);
a.send({ t: 'em', e: 'heart' });
a.send({ t: 'em', e: 'up' });
await sleep(500);
ok('表情冷却内被吞并，白名单外不转发', !b.has((m) => m.t === 'em'));
b.inbox.length = 0;
a.send({ t: 'em', e: 'nope' });
await sleep(300);
ok('非法表情被丢弃', !b.has((m) => m.t === 'em'));

b.send({ t: 'pv', v: 1 });
await b.until((m) => m.t === 'pv' && m.p === hb.pid && m.v === 1);
a.send({ t: 'pk', k: hb.pid, d: 99 });
const pk = await b.until((m) => m.t === 'pk');
ok('双方开启后命中，伤害被服务端封顶', pk.a === ha.pid && pk.s === hb.pid && pk.d === 24, 'd=' + pk.d);
a.send({ t: 'pk', k: hb.pid, d: 5 });
await sleep(400);
ok('伤害冷却 (300ms) 内的第二击被丢弃', !b.has((m) => m.t === 'pk' && m.d === 5));

// 拉开距离后再打：应超出切磋射程
a.send({ t: 'st', ts: Date.now(), x: 5, y: 2, z: 16, Y: 1.2, a: {} });
b.send({ t: 'st', ts: Date.now(), x: 5, y: 2, z: 60, Y: 1.2, a: {} });
await sleep(120);
a.send({ t: 'pk', k: hb.pid, d: 5 });
await sleep(400);
ok('超出距离的伤害被拒绝', !b.has((m) => m.t === 'pk' && m.d === 5));

// 标点呼叫
a.send({ t: 'pg', x: 12.34, z: -56.78 });
const pg = await b.until((m) => m.t === 'pg');
ok('标点转发并带发起者名字', Math.abs(pg.x - 12.3) < 0.15 && pg.n === '小樱');
a.send({ t: 'pg', x: 1, z: 1 });
await sleep(400);
ok('标点冷却 (2.5s) 生效', !b.has((m) => m.t === 'pg' && m.x === 1));
ok('标点不会回传给发起者', !a.has((m) => m.t === 'pg'));

// 离开
a.send({ t: 'leave' });
const gone = await b.until((m) => m.t === 'gone');
log('gone ok:', gone.p === ha.pid);

const h = await fetch(HTTP + '/healthz').then((r) => r.json());
log('healthz:', JSON.stringify(h));
a.ws.close(); b.ws.close();
log(fails ? 'SMOKE FAIL (' + fails + ')' : 'SMOKE PASS');
process.exit(fails ? 1 : 0);
