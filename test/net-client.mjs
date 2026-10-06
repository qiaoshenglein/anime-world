// 客户端联网层集成测试：stub DOM 下驱动真实 src/net.js，同进程再扮演一个队友端。
// 运行: URL=ws://localhost:8770/ws bun test/net-client.mjs
const R = [];
const ok = (name, cond, extra) => { R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : '')); };

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
let emSeen = null, emAll = [], pvpSeq = [], hitSeen = null, peerHitSeq = [], pingSeen = null;
let welcomeSeen = null, skSeen = null, outSeq = [];
const worldSeq = [], shardSeq = [], boardSeq = [];
const peerWsSeq = [];
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
  onWelcome: (d) => { welcomeSeen = d; },
  onWorld: (w) => { worldSeq.push(w); },
  onShardTaken: (s) => { shardSeq.push(s); },
  onBoards: () => { boardSeq.push('list'); },
  onBoard: (b) => { boardSeq.push(b); },
  onBoardGone: (p) => { boardSeq.push('gone:' + p); },
  onPeerEmote: (kind, name, r) => {
    if (!emSeen) emSeen = { kind, name, withRemote: !!r && r.name === name, attached: !!r && !!r.bubble && !!r.bubble.parent };
    emAll.push(kind);   // 合奏那次同伴还得再做一遍动作，两句都要能收到
  },
  onPeerPvp: (on, name) => { pvpSeq.push(name + ':' + (on ? 1 : 0)); },
  onPlayerHit: (h) => { hitSeen = h; },
  onPeerHit: (v, dmg) => { peerHitSeq.push((v ? v.name : '?') + '/' + dmg); },
  onPing: (g) => { pingSeen = g; },
  onDuet: (e) => { duetSeen = e; },
};
const _send = net._send.bind(net);
const rsSeq = [];
let iter = 0;
net.connect = (name, look) => {
  net.profile = { n: name, look: look || null };
  net._send = (o) => {
    if (o.t === 'st') rsSeq.push(iter + ':' + (o.rs || 0));
    if (o.t !== 'st') outSeq.push(o); // 权威上报的每一条都得能被断言（位置帧太密不入账）
    _send(o.t === 'join' ? { ...o, l: LANE } : o);
  };
  net._open();
};
net.init(api);
net.connect('联测君', { hair: 0x88ff00 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 队友端（裸 ws，扮演“小测”）：入房、绕圈移动、发聊天，并按剧本发起切磋/表情/标点
const P = { pos: new THREE.Vector3(0, 1.5, 16), vel: new THREE.Vector3(3, 0, 0), yaw: 1, grounded: true, swim: false, glide: false, hurtT: 0, dead: false };
let myPid = null, peerSelf = null, boardEcho = null;
function peerConnect() {
  const ws = new WebSocket(URL_);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello' })));
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(String(e.data));
    if (d.t === 'hello') { peerSelf = d.pid; ws.send(JSON.stringify({ t: 'join', r: 'sakura', l: LANE, p: { n: '小测', look: { hair: 0x88ff00 } } })); }
    if (d.t === 'mb' && d.p !== peerSelf) boardEcho = d;
    if (d.t === 'sk') skSeen = d;
    if (d.t === 'ws') peerWsSeq.push(d);
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

let chatSent = false, earlyTarget = null, lateTarget = null, sentPk = false, hitSent = false, duetSeen = null;
const findPeer = () => remotes().find((x) => x.name === '小测');
for (let i = 0; i < 150; i++) { // ~10s @15Hz
  await sleep(66);
  iter = i;
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
    // 合奏：同伴先撒星屑（i=85，此时两人已经挨着），我两拍后跟着撒同一个动作（i=87）
    if (i === 85) ws.send(JSON.stringify({ t: 'em', e: 'spark' }));
    if (i === 87) net.emote('spark');
    if (i === 118) net.emote('heart');   // 表情有自己的 1.5s 冷却，这一句挪到冷却之后
    if (i === 70 && myPid) ws.send(JSON.stringify({ t: 'pk', k: myPid, d: 7 }));
    if (i === 80) ws.send(JSON.stringify({ t: 'pg', x: 3.4, z: 8.6 }));
    if (i === 44 && rp) ws.send(JSON.stringify({ t: 'mb', x: +(rp.tx + 9).toFixed(1), z: +rp.tz.toFixed(1), s: '同伴留下的话 <b>\ud83d\udc4b' }));
    if (i === 66) net.board(P.pos.x, P.pos.z, '我也刻一句');
    if (!hitSent && i >= 90 && rp) { hitSent = true; net.hit(rp.id, 5); net.ping(P.pos.x, P.pos.z); }
    if (i === 100) P.pos.set(140, 2, -60); // 模拟死亡重生/切后台回来造成的位置大跳
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
R.push('DBG pvp=' + JSON.stringify(pvpSeq) + ' hit=' + JSON.stringify(hitSeen) + ' peerHit=' + JSON.stringify(peerHitSeq) + ' ping=' + JSON.stringify(pingSeen) + ' em=' + JSON.stringify(emSeen) + ' emAll=' + JSON.stringify(emAll));
ok('对方开启切磋会同步到远端状态', !!peer && peer.pvp === true);
ok('切磋回声只来自他人，不给自己重复提示', pvpSeq.length > 0 && pvpSeq.every((s) => s.startsWith('小测')), JSON.stringify(pvpSeq));
ok('收到远端表情并带上该玩家', !!emSeen && emSeen.kind === 'wave' && emSeen.withRemote);
R.push('DBG duet=' + JSON.stringify(duetSeen));
ok('合奏由服务端判定，联网层只把它交给游戏（客户端不自己发钱）', !!duetSeen && duetSeen.e === 'spark' && duetSeen.g === 1 && [duetSeen.a, duetSeen.b].includes(net.pid) && (duetSeen.na === '小测' || duetSeen.nb === '小测'), JSON.stringify(duetSeen));
ok('受到的切磋伤害回调含伤害值与来源名', !!hitSeen && hitSeen.dmg === 7 && hitSeen.by === '小测');
ok('本地出手后收到服务端回传的命中', peerHitSeq.some((s) => s === '小测/5'));
ok('击中队友时其角色进入受击闪烁', !!peer && peer.char.flash === 1);
ok('标点回调带坐标与发起者', !!pingSeen && Math.abs(pingSeen.x - 3.4) < 0.1 && pingSeen.name === '小测');
ok('远端表情气泡已挂进场景', !!emSeen && emSeen.attached);
const pb = [...net.boards.values()].find((b) => b.by === '小测');
ok('留言石碑回灌进本地镜像', !!pb && pb.s.startsWith('同伴留下的话'), 's=' + (pb && pb.s) + ' boards=' + net.boards.size);
ok('服务端净化后的留言才进镜像', !!pb && !/[<>]/.test(pb.s) && !pb.s.includes('\ud83d\udc4b'), 's=' + (pb && pb.s));
ok('自己刻的留言也回灌到 myBoard', !!net.myBoard() && net.myBoard().s === '我也刻一句', 'my=' + JSON.stringify(net.myBoard()));
ok('本地刻碑会广播给同伴（消息类型未被时间戳覆盖）', !!boardEcho && boardEcho.s === '我也刻一句' && boardEcho.p === net.pid, JSON.stringify(boardEcho));
// ---- 服务端权威：快照灌入、上报去重、身份升级
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
ok('welcome 带回权威世界快照（含王血量上限）',
  !!welcomeSeen && net.world.stage === 0 && net.world.kingAlive && net.world.kingMax > 0 && Array.isArray(welcomeSeen.shards),
  JSON.stringify(net.world));
ok('匿名身份没有进度与战绩可同步', welcomeSeen.me === null && net.prog === null && net.record === null);
const tx = Math.round(P.pos.x), tz = Math.round(P.pos.z);
net.take(P.pos.x, P.pos.z);
await nap(320);
ok('采下的碎片由服务端确认并进入本地 taken 集合', !!skSeen && skSeen.x === tx && skSeen.z === tz && net.shardTaken(P.pos.x, P.pos.z), JSON.stringify(skSeen));
ok('广播含自己：本地镜像同步消失（onShardTaken 触发）', shardSeq.some((s) => s.x === tx && s.z === tz));
skSeen = null;
net.take(P.pos.x, P.pos.z);
await nap(460);   // 服务端每人 0.4s 才认一帧采集：留出间隔，才能区分「去重」与「限流」
ok('同一块碎片重复上报不再广播', skSeen === null);
net.take(300, 300);
await nap(460);
ok('隔空采集被服务端拒绝（人不在现场）', !shardSeq.some((s) => s.x === 300) && skSeen === null);
net.quest({ st: 1 });
await nap(320);
ok('任务推进经服务端下发快照并落进本地', peerWsSeq.some((w) => w.st === 1) && net.world.stage === 1, JSON.stringify(net.world));
// 只看这两次乱提交之后的快照：开潮之类的正常改动也会下发 ws，不能一并算成「被接受」
const wsAt = peerWsSeq.length;
net.quest({ st: 6 });
net.quest({ st: 0 });
await nap(320);
ok('跳格与回退都不被接受', !peerWsSeq.slice(wsAt).some((w) => w.st === 6 || w.st === 0) && net.world.stage === 1, JSON.stringify(peerWsSeq.slice(wsAt).map((w) => w.st)));
net.kingHit(5);
await nap(320);
ok('王的血量由服务端累计', net.world.kingHp === net.world.kingMax - 5, 'kh=' + net.world.kingHp);
net.kingHit(5); net.kingHit(5); net.kingHit(5);
await nap(320);
ok('连点不会瞬间打死（服务端限流）', net.world.kingHp > net.world.kingMax - 15, 'kh=' + net.world.kingHp);
net.kingHit(999);
await nap(320);
ok('单跳伤害被封顶（改内存秒杀失效）', net.world.kingHp > 0, 'kh=' + net.world.kingHp);
ok('远端匿名旅伴没有可追责的身份', !!peer && peer.acct === null);
net.died();
await nap(200);
ok('倒下只上报个人档案，不动分线世界', outSeq.some((o) => o.t === 'qs' && o.de === 1) && net.world.stage === 1);
ok('没有身份时不给屏蔽入口（联网层直接不发）', (net.mute('a-x'), !outSeq.some((o) => o.t === 'mu')));
// 身份升级：留言/屏蔽/举报都按账号而不是连接 id
net.me = { a: 'a-fake-acct', n: '联测君', bound: false };
net.boards.set('a-fake-acct', { p: 'a-fake-acct', x: 1, z: 1, s: '按账号存的那句', by: '联测君', l: 0 });
ok('有账号时留言按账号取回（重连后自己那句还在）', net.myBoard()?.s === '按账号存的那句' && net.boardKey() === 'a-fake-acct');
ok('自己的留言认账号、不认连接 id', net.isMineBoard('a-fake-acct') && !net.isMineBoard(net.pid));
net.mute('a-other');
net.report('a-other', '骂人');
await nap(120);
ok('有身份后才能屏蔽与举报', outSeq.some((o) => o.t === 'mu' && o.u === 'a-other') && outSeq.some((o) => o.t === 'rp' && o.u === 'a-other' && o.r === '骂人'));
net.me = null;

// 位置重同步：首帧 + 本地大跳后一帧，必须带 rs，否则服务端速度校验会永久丢弃该玩家
R.push('DBG rs=' + JSON.stringify(rsSeq.filter((s) => s.endsWith(':1')).slice(0, 6)));
const rsOn = rsSeq.filter((s) => s.endsWith(':1')).map((s) => Number(s.split(':')[0]));
ok('入房首帧声明重同步', rsOn.length > 0 && rsOn[0] < 20, JSON.stringify(rsOn.slice(0, 4)));
ok('位置大跳后立刻声明重同步', rsOn.some((i) => i >= 101 && i <= 104), JSON.stringify(rsOn.slice(0, 6)));
ok('平稳移动时不滥用重同步', rsSeq.filter((s) => s.endsWith(':1')).length <= 4 && rsSeq.length > 60);

// 上行背压：发送失败时按「旧→新」排队并丢弃最老的，陈旧位置帧不得把同伴拽回过去
net.ws = { readyState: 1, send() { throw new Error('buffered'); } };
for (let i = 0; i < 60; i++) net._send({ t: 'st', x: i });
const ob = net.outbox || [];
ok('上行队列有上限', ob.length === 40, 'len=' + ob.length);
ok('队列旧→新且丢最老', JSON.parse(ob[0]).x === 20 && JSON.parse(ob[ob.length - 1]).x === 59);
net.ws = null; net.outbox = [];

// ---- 天气也是规则：这套服务端被 run-all 钉成「细雨」，所以采到的一枚碎片该给两撇星尘
const HTTP_ = URL_.replace(/^ws:/, 'http:').replace(/\/ws$/, '');
const gres = await fetch(HTTP_ + '/api/guest', { method: 'POST', headers: { 'content-type': 'application/json' } });
const gcookie = (gres.headers.get('set-cookie') || '').split(';')[0];
await gres.json();
let gWel = null;
const prSeq = [];
const gw = new WebSocket(URL_, { headers: { cookie: gcookie } });
gw.addEventListener('message', (e) => {
  const d = JSON.parse(String(e.data));
  if (d.t === 'hello') gw.send(JSON.stringify({ t: 'join', r: 'sakura', l: LANE, p: { n: '雨旅人' } }));
  if (d.t === 'welcome') gWel = d;
  if (d.t === 'pr') prSeq.push(d.prog);
});
// 先挂监听再等 open：服务端一接上就把 hello 推下来，晚一步这条链就再也走不动了
gw.addEventListener('open', () => gw.send(JSON.stringify({ t: 'hello' })), { once: true });
await new Promise((res) => gw.addEventListener('open', res, { once: true }));
await nap(500);
ok('钉住的天跟着快照下发（这条线此刻在下雨）', gWel?.world?.we === 2, JSON.stringify(gWel && gWel.world));
ok('带着 Cookie 的连接有身份、有档案', !!gWel?.prog && gWel.prog.gem === 0 && gWel.me?.a != null, JSON.stringify(gWel && gWel.me));
gw.send(JSON.stringify({ t: 'tk', x: 4, z: 20 }));   // 服务端记录他在 (0,16) 附近，这个坐标在现场范围内
await nap(400);
const gp = prSeq[prSeq.length - 1];
ok('细雨里采到的那一枚给两撇星尘（由服务端加发）', !!gp && gp.shards === 1 && gp.gem === 2, JSON.stringify(gp));
gw.send(JSON.stringify({ t: 'qs', wi: 1 }));
await nap(400);
const gp2 = prSeq[prSeq.length - 1];
ok('不是流星夜时许愿不多给（奖励只认那张表）', !!gp2 && gp2.wish === 1 && gp2.gem === 2, JSON.stringify(gp2));
gw.close();

ws.close();
net.disconnect();
console.log(R.join('\n'));
console.log(R.some((x) => x.startsWith('FAIL')) ? 'INTEGRATION FAIL' : 'INTEGRATION PASS');
process.exit(R.some((x) => x.startsWith('FAIL')) ? 1 : 0);
