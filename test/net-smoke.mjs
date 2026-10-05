// P1 协议冒烟测试：bun test/net-smoke.mjs （需先起 server）
const URL = process.env.URL || 'ws://localhost:8770/ws';
const HTTP = URL.replace(/^ws/, 'http').replace(/\/ws\/?$/, '');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  return {
    ws, inbox,
    until: async (pred, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const m = inbox.find(pred);
        if (m) { inbox.splice(inbox.indexOf(m), 1); return m; }
        await sleep(30);
      }
      throw new Error(name + ': timeout waiting for ' + pred.toString());
    },
  };
}

const a = client('A'), b = client('B');
await sleep(300);
a.ws.send(JSON.stringify({ t: 'hello' }));
b.ws.send(JSON.stringify({ t: 'hello' }));
const ha = await a.until((m) => m.t === 'hello'), hb = await b.until((m) => m.t === 'hello');
log('hello ok:', ha.pid, hb.pid);

a.ws.send(JSON.stringify({ t: 'join', r: 'sakura', l: 0, p: { n: '小樱', look: { hair: 0xff0000 } } }));
const wa = await a.until((m) => m.t === 'welcome');
log('welcome A ok, players:', wa.players.length, 'tok:', !!wa.tok);

b.ws.send(JSON.stringify({ t: 'join', r: 'sakura', l: 0, p: { n: '阿澈' } }));
const wb = await b.until((m) => m.t === 'welcome');
const seenA = await a.until((m) => m.t === 'roster' && m.players.some((p) => p.n === '阿澈'));
log('welcome B ok; A sees roster with', seenA.players.length, 'players');

// 移动同步：正常移动应转发
a.ws.send(JSON.stringify({ t: 'st', ts: Date.now(), x: 5, y: 2, z: 16, Y: 1.2, a: { sp: 6, glid: 0 } }));
const nv = await b.until((m) => m.t === 'nv');
log('nv ok:', JSON.stringify(nv.l[0]));

// 瞬移作弊：应被丢弃（1.5s 内不应看到 300,300）
a.ws.send(JSON.stringify({ t: 'st', x: 300, y: 2, z: 300, Y: 0, a: {} }));
await sleep(1200);
const cheat = b.inbox.some((m) => m.t === 'nv' && m.l.some((s) => s.x > 200));
log('teleport blocked:', !cheat ? 'YES' : 'NO — FAILED');

// 聊天
a.ws.send(JSON.stringify({ t: 'ch', m: '你好呀 <script>' }));
const ch = await b.until((m) => m.t === 'msg');
log('chat ok:', ch.n, ch.m, '| sanitized:', !ch.m.includes('<'));

// 离开
a.ws.send(JSON.stringify({ t: 'leave' }));
const gone = await b.until((m) => m.t === 'gone');
log('gone ok:', gone.p === ha.pid);

const h = await fetch(HTTP + '/healthz').then((r) => r.json());
log('healthz:', JSON.stringify(h));
a.ws.close(); b.ws.close();
log('SMOKE PASS');
