// 客户端联网层集成测试：stub DOM 下驱动真实 src/net.js，同进程再扮演一个队友端。
// 运行: URL=ws://localhost:8770/ws bun test/net-client.mjs
const R = [];
const ok = (name, cond) => { R.push((cond ? 'PASS ' : 'FAIL ') + name); };

const ctxStub = () => ({
  font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textAlign: '', textBaseline: '',
  measureText: (t) => ({ width: t.length * 26 }),
  beginPath() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {},
});
const elStub = () => ({
  width: 0, height: 0, getContext: () => ctxStub(),
  style: {}, classList: { add() {}, remove() {}, toggle() {} },
  children: [], appendChild() {}, removeChild() {}, addEventListener() {}, value: '', textContent: '',
});
globalThis.document = { createElement: () => elStub() };
globalThis.window = globalThis;
globalThis.sessionStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };
globalThis.location = { protocol: 'ws:', host: (process.env.URL || '').replace(/^ws:\/\//, '') || 'localhost:8770', search: '' };

const { net } = await import('../src/net.js');
const THREE = (await import('three')).default || (await import('three'));

const URL_ = process.env.URL || 'ws://localhost:8770/ws';
const LANE = process.env.LANE !== undefined ? Number(process.env.LANE) : Math.floor(Math.random() * 4);
net.url = URL_;

let peerAdded = null, chatSeen = null, stateSeq = [];
const remotes = () => [...net.remotes.values()];
const api = {
  scene: new THREE.Scene(),
  buildCharacter: (opts) => {
    const root = new THREE.Object3D();
    return { opts, root, animate: () => {}, mats: [] };
  },
  groundAt: () => 1.5,
  clock: 0,
  onNetState: (s, c) => { stateSeq.push(s + '/' + c); },
  onChat: (n, m, self) => { chatSeen = { n, m }; },
  onPeerJoin: (name) => { peerAdded = name; },
  onPeerLeave: () => {},
  onNetErr: () => {},
};
const _send = net._send.bind(net);
net.connect = (name, look) => {
  net.profile = { n: name, look: look || null };
  net._send = (o) => { _send(o.t === 'join' ? { ...o, l: LANE } : o); };
  net._open();
};
net.init(api);
net.connect('联测君', { hair: 0x88ff00 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 队友端（裸 ws，扮演“小测”）：入房、绕圈移动、发聊天
const P = { pos: new THREE.Vector3(0, 1.5, 16), vel: new THREE.Vector3(3, 0, 0), yaw: 1, grounded: true, swim: false, glide: false, hurtT: 0, dead: false };
function peerConnect() {
  const ws = new WebSocket(URL_);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello' })));
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(String(e.data));
    if (d.t === 'hello') ws.send(JSON.stringify({ t: 'join', r: 'sakura', l: LANE, p: { n: '小测', look: { hair: 0x88ff00 } } }));
    if (d.t === 'welcome') { joined = true; R.push('DBG peer welcomed'); }
  });
  return ws;
}
let ws = peerConnect();
let joined = false, ang = 0;

let chatSent = false, earlyTarget = null, lateTarget = null;
for (let i = 0; i < 150; i++) { // ~10s @15Hz
  await sleep(66);
  api.clock = i * 0.066;
  P.pos.x = Math.min(P.pos.x + 0.2, 12);
  net.tick(P, {}, 0.066);
  if (joined) {
    ang += 0.35;
    ws.send(JSON.stringify({
      t: 'st', ts: Date.now(),
      x: +(5 + Math.sin(ang) * 4).toFixed(2), y: 2, z: +(10 + Math.cos(ang) * 4).toFixed(2),
      Y: +ang.toFixed(2), a: { sp: 6 },
    }));
    if (!chatSent && i > 30) { chatSent = true; ws.send(JSON.stringify({ t: 'ch', m: '看得到我吗' })); }
    const p = remotes().find((x) => x.name === '小测');
    if (p && i === 40) earlyTarget = [p.tx, p.tz];
    if (p && i === 120) lateTarget = [p.tx, p.tz];
  }
}

const peer = remotes().find((x) => x.name === '小测');
R.push('DBG lane=' + LANE + ' state=' + JSON.stringify(stateSeq.slice(0, 8)) + ' remotes=' + remotes().map((x) => x.name) + ' peerPos=' + (peer ? peer.gx.toFixed(1) + ',' + peer.gz.toFixed(1) : '-') + ' chat=' + JSON.stringify(chatSeen));
ok('远端玩家被创建(小测)', !!peer);
ok('远端位置插值到轨迹附近', !!peer && Math.hypot(peer.gx - 5, peer.gz - 10) < 8);
ok('在线计数含两名玩家', stateSeq.some((s) => Number(s.split('/')[1]) >= 2));
ok('收到远端聊天', chatSeen && chatSeen.n === '小测' && chatSeen.m === '看得到我吗');
ok('外观 look 透传', !!peer && peer.char.opts && peer.char.opts.hair === 0x88ff00);
ok('远端已挂进场景', !!peer && peer.char.root.parent === api.scene);
// 回归：15Hz 持续上报不得被限流误封（曾致 4s 后位置帧全部丢弃）
ok('8秒后位置帧仍在生效', !!earlyTarget && !!lateTarget && Math.hypot(lateTarget[0] - earlyTarget[0], lateTarget[1] - earlyTarget[1]) > 1);

ws.close();
net.disconnect();
console.log(R.join('\n'));
console.log(R.some((x) => x.startsWith('FAIL')) ? 'INTEGRATION FAIL' : 'INTEGRATION PASS');
process.exit(R.some((x) => x.startsWith('FAIL')) ? 1 : 0);
