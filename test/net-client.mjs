// 客户端联网层集成测试：stub DOM 下驱动真实 src/net.js，同进程再扮演一个队友端。
// 运行: URL=ws://localhost:8770/ws bun test/net-client.mjs
const R = [];
const ok = (name, cond) => { R.push((cond ? 'PASS ' : 'FAIL ') + name); };

const ctxStub = () => ({
  font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textAlign: '', textBaseline: '',
  measureText: (t) => ({ width: t.length * 26 }),
  beginPath() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {}, arc() {}, closePath() {},
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
let emSeen = null, pvpSeq = [], hitSeen = null, peerHitSeq = [], pingSeen = null;
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
  onPeerEmote: (kind, name, r) => {
    emSeen = { kind, name, withRemote: !!r && r.name === name, attached: !!r && !!r.bubble && !!r.bubble.parent };
  },
  onPeerPvp: (on, name) => { pvpSeq.push(name + ':' + (on ? 1 : 0)); },
  onPlayerHit: (h) => { hitSeen = h; },
  onPeerHit: (v, dmg) => { peerHitSeq.push((v ? v.name : '?') + '/' + dmg); },
  onPing: (g) => { pingSeen = g; },
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

// 队友端（裸 ws，扮演“小测”）：入房、绕圈移动、发聊天，并按剧本发起切磋/表情/标点
const P = { pos: new THREE.Vector3(0, 1.5, 16), vel: new THREE.Vector3(3, 0, 0), yaw: 1, grounded: true, swim: false, glide: false, hurtT: 0, dead: false };
let myPid = null, peerSelf = null;
function peerConnect() {
  const ws = new WebSocket(URL_);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello' })));
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(String(e.data));
    if (d.t === 'hello') { peerSelf = d.pid; ws.send(JSON.stringify({ t: 'join', r: 'sakura', l: LANE, p: { n: '小测', look: { hair: 0x88ff00 } } })); }
    if (d.t === 'welcome') {
      joined = true;
      const me = (d.players || []).find((p) => p.n === '联测君');
      if (me) myPid = me.p;
      R.push('DBG peer welcomed, myPid=' + myPid);
    }
    // 双方几乎同时入房，welcome 名册里未必已有我：改从位置广播里认领对手 id
    if (d.t === 'nv' && !myPid) myPid = (d.l || []).map((s) => s.p).find((p) => p !== peerSelf) || null;
    if (d.t === 'roster' && !myPid) { const me = (d.players || []).find((p) => p.n === '联测君'); if (me) myPid = me.p; }
  });
  return ws;
}
let ws = peerConnect();
let joined = false, ang = 0;

let chatSent = false, earlyTarget = null, lateTarget = null, sentPk = false, hitSent = false;
const findPeer = () => remotes().find((x) => x.name === '小测');
for (let i = 0; i < 150; i++) { // ~10s @15Hz
  await sleep(66);
  api.clock = i * 0.066;
  const rp = findPeer();
  if (i > 45 && rp) {
    // 走近队友（每帧限速，避免被服务端当成瞬移丢弃）
    const dx = rp.tx + 1.2 - P.pos.x, dz = rp.tz + 1.2 - P.pos.z, d = Math.hypot(dx, dz) || 1;
    const step = Math.min(d, 4);
    P.pos.x += (dx / d) * step; P.pos.z += (dz / d) * step;
  } else P.pos.x = Math.min(P.pos.x + 0.2, 12);
  net.tick(P, {}, 0.066);
  if (joined) {
    ang += 0.35;
    ws.send(JSON.stringify({
      t: 'st', ts: Date.now(),
      x: +(5 + Math.sin(ang) * 4).toFixed(2), y: 2, z: +(10 + Math.cos(ang) * 4).toFixed(2),
      Y: +ang.toFixed(2), a: { sp: 6 },
    }));
    if (!chatSent && i > 30) { chatSent = true; ws.send(JSON.stringify({ t: 'ch', m: '看得到我吗' })); }
    if (i === 40) net.pvp(true); // 我方先开启切磋（服务端会回声，客户端须屏蔽）
    if (i === 50) ws.send(JSON.stringify({ t: 'pv', v: 1 })); // 对方也开启
    if (i === 60) ws.send(JSON.stringify({ t: 'em', e: 'wave' }));
    if (i === 70 && myPid) ws.send(JSON.stringify({ t: 'pk', k: myPid, d: 7 }));
    if (i === 80) ws.send(JSON.stringify({ t: 'pg', x: 3.4, z: 8.6 }));
    if (!hitSent && i >= 90 && rp) { hitSent = true; net.hit(rp.id, 5); net.emote('heart'); net.ping(P.pos.x, P.pos.z); }
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

// ---- 玩家间交互
R.push('DBG pvp=' + JSON.stringify(pvpSeq) + ' hit=' + JSON.stringify(hitSeen) + ' peerHit=' + JSON.stringify(peerHitSeq) + ' ping=' + JSON.stringify(pingSeen) + ' em=' + JSON.stringify(emSeen));
ok('对方开启切磋会同步到远端状态', !!peer && peer.pvp === true);
ok('切磋回声只来自他人，不给自己重复提示', pvpSeq.length > 0 && pvpSeq.every((s) => s.startsWith('小测')), JSON.stringify(pvpSeq));
ok('收到远端表情并带上该玩家', !!emSeen && emSeen.kind === 'wave' && emSeen.withRemote);
ok('受到的切磋伤害回调含伤害值与来源名', !!hitSeen && hitSeen.dmg === 7 && hitSeen.by === '小测');
ok('本地出手后收到服务端回传的命中', peerHitSeq.some((s) => s === '小测/5'));
ok('击中队友时其角色进入受击闪烁', !!peer && peer.char.flash === 1);
ok('标点回调带坐标与发起者', !!pingSeen && Math.abs(pingSeen.x - 3.4) < 0.1 && pingSeen.name === '小测');
ok('远端表情气泡已挂进场景', !!emSeen && emSeen.attached);

ws.close();
net.disconnect();
console.log(R.join('\n'));
console.log(R.some((x) => x.startsWith('FAIL')) ? 'INTEGRATION FAIL' : 'INTEGRATION PASS');
process.exit(R.some((x) => x.startsWith('FAIL')) ? 1 : 0);
