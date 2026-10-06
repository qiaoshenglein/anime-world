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
await sleep(700);
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
await sleep(320);
ok('对方未开启切磋时不结算伤害', !b.has((m) => m.t === 'pk'));

a.send({ t: 'em', e: 'wave' });
const em = await b.until((m) => m.t === 'em');
ok('表情转发', em.e === 'wave' && em.p === ha.pid);
a.send({ t: 'em', e: 'heart' });
a.send({ t: 'em', e: 'up' });
await sleep(350);
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
await sleep(320);
ok('伤害冷却 (300ms) 内的第二击被丢弃', !b.has((m) => m.t === 'pk' && m.d === 5));

// 拉开距离后再打：应超出切磋射程
a.send({ t: 'st', ts: Date.now(), x: 5, y: 2, z: 16, Y: 1.2, a: {} });
b.send({ t: 'st', ts: Date.now(), x: 5, y: 2, z: 60, Y: 1.2, a: {} });
await sleep(120);
a.send({ t: 'pk', k: hb.pid, d: 5 });
await sleep(320);
ok('超出距离的伤害被拒绝', !b.has((m) => m.t === 'pk' && m.d === 5));

// 标点呼叫
a.send({ t: 'pg', x: 12.34, z: -56.78 });
const pg = await b.until((m) => m.t === 'pg');
ok('标点转发并带发起者名字', Math.abs(pg.x - 12.3) < 0.15 && pg.n === '小樱');
a.send({ t: 'pg', x: 1, z: 1 });
await sleep(320);
ok('标点冷却 (2.5s) 生效', !b.has((m) => m.t === 'pg' && m.x === 1));
ok('标点不会回传给发起者', !a.has((m) => m.t === 'pg'));

// 大跳（死亡重生 / 切后台再回来）：不能永久丢弃，否则该玩家在其他人眼里定格在旧坐标
for (let i = 0; i < 4; i++) { a.send({ t: 'st', ts: Date.now(), x: 180, y: 2, z: -140, Y: 0, a: {} }); await sleep(70); }
const rs1 = await b.until((m) => m.t === 'nv' && m.l.some((s) => s.x > 170), 2500).catch(() => null);
ok('连续被拒后自动重同步，不再永久定格', !!rs1);

await sleep(1260); // 越过 1.2s 重同步节流
a.send({ t: 'st', ts: Date.now(), x: -200, y: 2, z: 200, Y: 0, rs: 1, a: {} });
const rs2 = await b.until((m) => m.t === 'nv' && m.l.some((s) => s.x < -190), 2500).catch(() => null);
ok('客户端自报瞬移 (rs) 时首帧即重同步', !!rs2);

for (let i = 0; i < 5; i++) { a.send({ t: 'st', ts: Date.now(), x: 300, y: 2, z: -300, Y: 0, rs: 1, a: {} }); await sleep(70); }
await sleep(300);
ok('重同步被节流，瞬移不能无限连发', !b.has((m) => m.t === 'nv' && m.l.some((s) => s.x > 290)));
const mx = await fetch(HTTP + '/metrics').then((r) => r.json());
ok('/metrics 汇报重同步次数', mx.resync >= 2, 'resync=' + mx.resync);

// 分线：?lane 深链要能落位，且分线之间互不可见（否则「约好同线」没有意义）
const c = client('C');
await sleep(200);
c.send({ t: 'hello' });
const hc = await c.until((m) => m.t === 'hello');
c.send({ t: 'join', r: 'sakura', l: 2, p: { n: '穿山甲' } });
const wc = await c.until((m) => m.t === 'welcome');
ok('指定分线落位 (l:2)', wc.lane === 2, 'lane=' + wc.lane);
ok('跨分线互相看不见', wc.players.every((p) => p.n !== '小樱' && p.n !== '阿澈'));
c.send({ t: 'st', ts: Date.now(), x: 7, y: 2, z: 7, Y: 0, rs: 1, a: {} });
await sleep(320);
const leak = (x) => x.has((m) => (m.t === 'nv' || m.t === 'roster') && JSON.stringify(m).includes(hc.pid));
ok('他人分线的状态不会串线', !leak(a) && !leak(b));
const rms = await fetch(HTTP + '/rooms').then((r) => r.json());
const lanes = new Set(rms.rooms.map((r) => r.l));
ok('/rooms 能区分分线', lanes.has(0) && lanes.has(2), 'lanes=' + [...lanes].join(','));
c.ws.close();

// ---------------------------------------------------------------- 留言石碑
// 把 A 挪回 B 附近（走重同步，模拟死亡重生）
await sleep(300);
a.send({ t: 'st', ts: Date.now(), x: 4, y: 2, z: 58, Y: 0, rs: 1, a: {} });
await sleep(150);
b.inbox.length = 0; a.inbox.length = 0;

// 只能刻在自己脚下：40 米外的那块应被拒
a.send({ t: 'mb', x: 44, z: 58, s: '太远了刻不下' });
// B 正常落碑，中文与标点保留
b.send({ t: 'mb', x: 5, z: 60, s: '山顶的风很凉' });
const mbB = await a.until((m) => m.t === 'mb' && m.p === hb.pid);
ok('留言广播给同线他人', mbB.s === '山顶的风很凉' && mbB.by === '阿澈', JSON.stringify(mbB.s));
ok('超出脚下范围的留言被拒', !a.has((m) => m.t === 'mb' && m.p === ha.pid));

// 与别人的石碑重叠（0.5m）→ 拒；A 因此还没消耗冷却
a.send({ t: 'mb', x: 5.4, z: 60.2, s: '重叠的一块' });
await sleep(250);
ok('石碑不得叠在一起', !b.has((m) => m.t === 'mb' && m.p === ha.pid));

// 合法位置 + 脏文本：标签、表情符号被白名单滤掉，中文留下
a.send({ t: 'mb', x: 12, z: 58, s: '一起爬山吧 <script>\ud83d\udc4b' });
const mbA = await b.until((m) => m.t === 'mb' && m.p === ha.pid);
ok('留言净化：去标签与表情', !/[<>]/.test(mbA.s) && mbA.s.includes('一起爬山吧') && !mbA.s.includes('\ud83d\udc4b'), 's=' + mbA.s);
ok('留言坐标按十分位存下', Math.abs(mbA.x - 12) < 0.15 && Math.abs(mbA.z - 58) < 0.15);

a.send({ t: 'mb', x: 20, z: 58, s: '第二次刻' });
await sleep(250);
ok('重刻冷却 (8s) 生效', !b.has((m) => m.t === 'mb' && m.s === '第二次刻'));

// 点赞：靠近才可以，不能给自己点，且有 4s 冷却
a.send({ t: 'ml', p: hb.pid });
const like = await b.until((m) => m.t === 'mb' && m.p === hb.pid && m.l === 1);
ok('路过的人可以为留言点心', like.l === 1 && like.s === '山顶的风很凉', 'l=' + like.l);
a.send({ t: 'ml', p: hb.pid });
a.send({ t: 'ml', p: ha.pid });
await sleep(250);
ok('点赞冷却且不能自点', !b.has((m) => m.t === 'mb' && m.p === hb.pid && m.l === 2) && !a.has((m) => m.t === 'mb' && m.p === ha.pid && m.l > 0));
b.send({ t: 'ml', p: ha.pid }); // B 在 5,60，A 的碑在 12,58 → 约 7.8m，允许
await sleep(250);
ok('作者之外的人都能点', a.has((m) => m.t === 'mb' && m.p === ha.pid && m.l === 1));

// 收回：石碑消失，但 B 的还在
a.send({ t: 'mx' });
const md = await b.until((m) => m.t === 'md');
ok('收回自己的石碑', md.p === ha.pid);

// 中途加入的人要能看到此前留下的痕迹（异步同游的核心）
const d = client('D');
await sleep(200);
d.send({ t: 'hello' });
await d.until((m) => m.t === 'hello');
d.send({ t: 'join', r: 'sakura', l: 0, p: { n: '晚到的人' } });
const wd = await d.until((m) => m.t === 'welcome');
const bs = wd.boards || [];
ok('新人 welcome 带上现存留言', bs.some((x) => x.p === hb.pid && x.s === '山顶的风很凉' && x.l === 1), 'boards=' + JSON.stringify(bs.map((x) => x.s)));
ok('已收回的石碑不会回灌', !bs.some((x) => x.p === ha.pid));
d.ws.close();

// 分线天气：随快照下发、按辰光轮转，同线人看见同一片天空
ok('welcome 带这条分线的天气', Number.isInteger(wa.world?.we) && wa.world.we >= 0 && wa.world.we <= 4, 'we=' + wa.world?.we);
a.inbox.length = 0; b.inbox.length = 0;
if (process.env.WEATHER_MS === '600') {   // 只有 run-all 把轮转调到 600ms 时才等得到换天
  const shifted = await b.until((m) => m.t === 'ws' && m.we !== wa.world.we, 6000).catch(() => null);
  ok('天气会自己换（服务端按时辰轮转）', !!shifted, 'we=' + shifted?.we);
  const seenSame = await a.until((m) => m.t === 'ws' && m.we === shifted?.we, 3000).catch(() => null);
  ok('同一条分线看见同一个天气', !!seenSame, 'a.we=' + seenSame?.we);
} else log('  --   天气轮转未验证（直连的服务器没把 WEATHER_MS 调短）');
// 新表情：鞠躬与起舞都要能传给同伴
await sleep(1600);
a.send({ t: 'em', e: 'bow' });
const emb = await b.until((m) => m.t === 'em' && m.e === 'bow', 2500);
ok('鞠躬广播给同线同伴', emb.p === ha.pid);
await sleep(1600);
a.send({ t: 'em', e: 'flip' });
await sleep(250);
ok('不在白名单里的动作被忽略', !b.has((m) => m.t === 'em' && m.e === 'flip'));

// 烟花：位置取整广播，八秒内第二朵不放
a.send({ t: 'fw', x: 20.4, z: 40.7 });
const fwa = await b.until((m) => m.t === 'fw', 2500);
ok('同伴看见你放的烟花（坐标取整）', fwa.x === 20 && fwa.z === 41 && fwa.n === '小樱', JSON.stringify(fwa));
a.send({ t: 'fw', x: 21, z: 41 });
await sleep(300);
ok('八秒冷却：连点不会把天空变成爆竹厂', !b.has((m) => m.t === 'fw' && m.x === 21));

// 离开：C 已经离开并触发过空分线回收，这条 gone 仍要送达（回收不得波及其他分线）
a.send({ t: 'leave' });
const gone = await b.until((m) => m.t === 'gone' && m.p === ha.pid, 2500);
ok('离开广播不受其他分线回收影响', gone.p === ha.pid);

const h = await fetch(HTTP + '/healthz').then((r) => r.json());
log('healthz:', JSON.stringify(h));
a.ws.close(); b.ws.close();
log(fails ? 'SMOKE FAIL (' + fails + ')' : 'SMOKE PASS');
process.exit(fails ? 1 : 0);
