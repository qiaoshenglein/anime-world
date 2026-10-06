// 账号 + 服务端权威的端到端验证：自带两个服务端实例（重启后同一库文件要还在）
// 运行: bun test/account.mjs
import { startServer } from './spawn.mjs';
const R = [];
const ok = (n, c, e) => R.push((c ? 'PASS ' : 'FAIL ') + n + (e ? '  [' + e + ']' : ''));
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1');
const DB = ROOT + 'test/.tmp-account.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { rmSync } = await import('node:fs');
for (const f of [DB, DB + '-wal', DB + '-shm']) rmSync(f, { force: true }); // 旧 schema 的残留库不能污染本次

let HTTP = '', URL_ = '', srv = null;
const srvEnv = { AW_DB: DB, KING_HP: '16', CHAT_RATE: '20', QUIET: '1', WEATHER_PIN: 'clear', TIDE_MS: '900', TIDE_HP: '20', TIDE_HIT: '8', TIDE_GEM: '5', DUET_MS: '4000', DUET_GEM: '3', DUET_DIST: '9', MAX_PER_IP: '16' };
async function boot() {
  const S = await startServer(ROOT, srvEnv, { tag: 'acct', stderr: 'pipe' }); // 端口由系统挑，遗留进程冒充不了
  HTTP = S.base; URL_ = S.ws; srv = S.proc;
}
const cli = (...args) => Bun.spawn([process.execPath, 'server/cli.js', ...args], {
  cwd: ROOT, env: { ...process.env, ...srvEnv }, stdout: 'pipe', stderr: 'pipe',
}).exited;

async function waitHealth(ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(HTTP + '/healthz')).ok) return true; } catch {}
    await sleep(150);
  }
  return false;
}
await boot();
ok('服务端起来了', await waitHealth());

// ---------------------------------------------------------------- HTTP 账号接口
let jar = '';
async function api(path, body, useJar = true) {
  const headers = { 'content-type': 'application/json' };
  if (useJar && jar) headers.cookie = jar;
  const r = await fetch(HTTP + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const c = r.headers.get('set-cookie');
  if (c) jar = c.split(';')[0];
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j, cookie: c };
}

async function apiAs(cookie, path, body) {
  const r = await fetch(HTTP + path, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, j: await r.json().catch(() => null) };
}
// 全新会话：不带任何 cookie，服务端会另开一个号
async function secondSession() {
  const r = await fetch(HTTP + '/api/guest', { method: 'POST', headers: { 'content-type': 'application/json' } });
  const j = await r.json();
  return { a: j.a, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const g1 = await api('/api/guest', {});
ok('游客自动开号（一次请求，无需注册表单）', g1.status === 200 && /^a[0-9a-f]{12,}$/.test(g1.j.a), JSON.stringify(g1.j));
ok('凭据走 HttpOnly + SameSite=Lax 的 Cookie', /HttpOnly/.test(g1.cookie) && /SameSite=Lax/.test(g1.cookie) && /Max-Age=\d{4,}/.test(g1.cookie), g1.cookie);
const ACCT = g1.j.a;
const g1b = await api('/api/guest', {});
ok('刷新页面不会又开一个新号', g1b.j.a === ACCT, g1b.j.a + ' vs ' + ACCT);
ok('未登录时 /api/me 只说匿名', (await api('/api/me', undefined, false)).j.anon === true);
ok('/api/me 认得当前会话', (await api('/api/me')).j.a === ACCT);

const weak = await api('/api/bind', { n: '阿澄', p: '123' });
ok('弱密码被拒', weak.status === 400 && weak.j.err === 'weak', JSON.stringify(weak.j));
const badName = await api('/api/bind', { n: '<i>x</i>', p: 'abcdef' });
ok('非法昵称被拒（名字先过白名单再入库）', badName.status === 400 && badName.j.err === 'name', JSON.stringify(badName.j));
const bound = await api('/api/bind', { n: '阿澄', p: 'abcdef' });
ok('绑定密码后游客号就地转正', bound.status === 200 && bound.j.bound === true && bound.j.a === ACCT, JSON.stringify(bound.j));
ok('转正后重复绑定被拒（不会被改密码/改名）', (await api('/api/bind', { n: '别人', p: 'abcdef' })).status === 409);

// 跨站请求拿不到 JSON content-type，这一步就挡住了伪造表单
const formPost = await fetch(HTTP + '/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'n=阿澄&p=abcdef' });
ok('表单式跨站请求被拒', formPost.status === 400);
const huge = await fetch(HTTP + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"p":"' + 'y'.repeat(9000) + '"}' });
ok('超大请求体被拒', huge.status === 400);

await api('/api/logout', {});
ok('退出后会话立刻作废', (await api('/api/me')).j.anon === true);
const wrong = await api('/api/login', { n: '阿澄', p: 'nope' });
ok('密码错只说「不对」，不说为什么', wrong.status === 401 && wrong.j.err === 'bad');
const right = await api('/api/login', { n: '阿澄', p: 'abcdef' });
ok('重新登录拿回同一个账号', right.status === 200 && right.j.a === ACCT && right.j.bound === true);
const dupS = await secondSession();
const dupR = await apiAs(dupS.cookie, '/api/bind', { n: '阿澄', p: 'abcdef2' });
jar = right.cookie.split(';')[0];
ok('名字先到先得，重名注册被拒', dupR.status === 409 && dupR.j.err === 'taken', JSON.stringify(dupR.j));

// ---------------------------------------------------------------- WS 身份与权威
function client(name, opts = {}) {
  const ws = new WebSocket(URL_, opts.cookie ? { headers: { cookie: opts.cookie } } : undefined);
  const inbox = [];
  ws.addEventListener('message', (e) => inbox.push(JSON.parse(String(e.data))));
  return {
    ws, inbox, name,
    send: (o) => ws.send(JSON.stringify(o)),
    until: async (pred, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const m = inbox.find(pred);
        if (m) { inbox.splice(inbox.indexOf(m), 1); return m; }
        await sleep(20);
      }
      throw new Error(name + ': timeout ' + pred.toString());
    },
    has: (pred) => !!inbox.find(pred),
  };
}
async function join(name, acctCookie, lane = 0) {
  const c = client(name, { cookie: acctCookie });
  await new Promise((res, rej) => { c.ws.addEventListener('open', res, { once: true }); c.ws.addEventListener('error', rej, { once: true }); });
  c.send({ t: 'hello' });
  const h = await c.until((m) => m.t === 'hello');
  c.send({ t: 'join', r: 'sakura', l: lane, p: { n: name, look: { hair: 0x336699 } } });
  const w = await c.until((m) => m.t === 'welcome');
  return { c, pid: h.pid, welcome: w };
}
// 服务端只认 cookie：不带 cookie 的连接照样能玩，但什么也不落库
const anon = await join('无号旅人', null);
ok('无 cookie 也能联机，但没有身份', anon.welcome.me === null && anon.welcome.lane === 0);
const me = await join('阿澄', jar);
ok('握手带上 cookie，进房就知道自己是谁', me.welcome.me?.a === ACCT && me.welcome.me?.bound === true, JSON.stringify(me.welcome.me));
ok('welcome 带进度与今日战绩', !!me.welcome.prog && me.welcome.prog.account === ACCT && !!me.welcome.pvp);
ok('welcome 带本分线的权威世界快照', me.welcome.world?.t === 'ws' && me.welcome.world.kh === 16 && me.welcome.world.km === 16 && Array.isArray(me.welcome.shards), JSON.stringify(me.welcome.world));

// 位置：先站定，采碎片与刻碑都按服务端记录的位置校验
me.c.send({ t: 'st', ts: Date.now(), x: 20, y: 2, z: 20, Y: 0, rs: 1, a: {} });
anon.c.send({ t: 'st', ts: Date.now(), x: 24, y: 2, z: 24, Y: 0, rs: 1, a: {} });
await sleep(200);

me.c.send({ t: 'tk', x: 20, z: 21 });
const sk = await anon.c.until((m) => m.t === 'sk');
ok('采下的碎片广播给同线他人', sk.x === 20 && sk.z === 21 && sk.c === 1 && sk.n === '阿澄', JSON.stringify(sk));
const pr = await me.c.until((m) => m.t === 'pr', 2000).catch(() => null);
ok('档案变化只回给本人（面板不会停在进房那一刻）', !!pr && pr.prog.shards === 1 && pr.prog.account === ACCT, JSON.stringify(pr));
ok('旁人收不到别人的档案', !anon.c.has((m) => m.t === 'pr'));
me.c.inbox.length = 0; anon.c.inbox.length = 0;
anon.c.send({ t: 'tk', x: 20, z: 21 });        // 同一块，换人来拿
await sleep(450);                               // 服务端每人 0.4s 才认一帧采集，否则第二帧会被限流吞掉而非判非法
anon.c.send({ t: 'tk', x: 300, z: 300 });      // 隔空（人在 24,24）
await sleep(300);
ok('同一条线上一块碎片只算一次（换号也刷不出第二块）', !anon.c.has((m) => m.t === 'sk') && !me.c.has((m) => m.t === 'sk'));
const m1 = await (await fetch(HTTP + '/metrics')).json();
ok('非法采集被计数', m1.take_rejected >= 2, 'take_rej=' + m1.take_rejected);

// 任务推进：只许一格一格往前
me.c.send({ t: 'qs', st: 1 });
const w1 = await anon.c.until((m) => m.t === 'ws' && m.st === 1);
ok('任务推进由服务端下发快照', w1.st === 1, JSON.stringify(w1));
// 从「已经确认收到 st=1」这一条往后看：更早的那次 st=0 下发属于开潮之类，不是回退被接受
const wsAfter1 = anon.c.inbox.length;
me.c.send({ t: 'qs', st: 7 });   // 跳格
me.c.send({ t: 'qs', st: 0 });   // 回退
await sleep(250);
ok('跳阶段与回退都无效', !anon.c.inbox.slice(wsAfter1).some((m) => m.t === 'ws' && (m.st === 7 || m.st === 0)), JSON.stringify(anon.c.inbox.slice(wsAfter1).map((m) => m.t + ':' + m.st)));
me.c.send({ t: 'qs', st: 2 });
await anon.c.until((m) => m.t === 'ws' && m.st === 2);
const m2 = await (await fetch(HTTP + '/metrics')).json();
ok('非法任务推进被计数', m2.world_rejected >= 2, 'w_rej=' + m2.world_rejected);

// Boss：血量在服务端累计，单跳伤害封顶，死后不再吃伤害
anon.c.inbox.length = 0;
me.c.send({ t: 'kb', d: 999 });
const kw = await anon.c.until((m) => m.t === 'ws' && m.kh < 16);
ok('单跳伤害被封顶（改内存秒杀失效）', kw.kh === 8, 'kh=' + kw.kh);
me.c.inbox.length = 0;
await sleep(260);   // 服务端每人 0.2s 才认一跳 Boss 伤害
me.c.send({ t: 'kb', d: 8 });
const dead = await me.c.until((m) => m.t === 'ws' && m.ka === 0, 3000);
ok('击败记录在权威血量上归零并广播', dead.kh === 0 && dead.ka === 0);
me.c.send({ t: 'kb', d: 8 });
await sleep(250);
ok('Boss 已死时不再吃伤害', !me.c.has((m) => m.t === 'ws' && m.kh === 0 && m.ka === 1));
// 另一条分线的 Boss 不受影响
const other = await join('别的线', null, 1);
ok('分线之间世界互相独立', other.welcome.world.ka === 1 && other.welcome.world.st === 0, JSON.stringify(other.welcome.world));

// 石碑：按账号存，一人一块，同一人同一天只能给同一作者一颗心
me.c.send({ t: 'mb', x: 22, z: 22, s: '山顶的风 <b>\ud83d\udc4b' });
const mb = await anon.c.until((m) => m.t === 'mb');
ok('留言净化后入库并广播', mb.s === '山顶的风 b' && mb.p === ACCT && mb.by === '阿澄', 's=' + mb.s);
anon.c.send({ t: 'st', ts: Date.now(), x: 23, y: 2, z: 23, Y: 0, rs: 1, a: {} });
await sleep(150);
anon.c.send({ t: 'ml', p: ACCT });
const liked = await me.c.until((m) => m.t === 'mb' && m.l === 1);
ok('靠近的人可以点心', liked.p === ACCT && liked.by === '阿澄');
anon.c.send({ t: 'ml', p: ACCT });
await sleep(250);
ok('同一人同一天对同一作者只有一颗心（重立碑也刷不出第二颗）', !me.c.has((m) => m.t === 'mb' && m.l === 2));
anon.c.inbox.length = 0;
other.c.send({ t: 'st', ts: Date.now(), x: 5, y: 2, z: 5, Y: 0, rs: 1, a: {} });
other.c.send({ t: 'ml', p: ACCT });   // 在 1 线，够不着 0 线的碑
await sleep(250);
ok('不能跨分线给碑点心', !anon.c.has((m) => m.t === 'mb') && !me.c.has((m) => m.t === 'mb' && m.l === 2));

// 静音：屏蔽社交信号，但不抹掉人在世界里的存在（需要两个都有账号的连接）
const B = await secondSession();
const bBind = await apiAs(B.cookie, '/api/bind', { n: '第二个旅人', p: 'abcdef-b' });
ok('第二个账号能独立绑定昵称', bBind.status === 200 && bBind.j.bound === true, JSON.stringify(bBind.j));
const b2 = await join('第二个旅人', B.cookie, 0);
ok('第二个账号有独立身份', b2.welcome.me?.a === B.a && b2.welcome.me?.a !== ACCT && b2.welcome.me?.n === '第二个旅人');
const anonId = other.welcome.players.find((x) => x.n === '无号旅人')?.u || null;
ok('无账号连接没有可静音的身份', anonId === null || anonId === undefined);

b2.c.send({ t: 'mu', u: ACCT });            // B 静音阿澄
await sleep(150);
b2.c.inbox.length = 0;
me.c.send({ t: 'ch', m: 'After mute' });
me.c.send({ t: 'pg', x: 30, z: 30 });
me.c.send({ t: 'em', e: 'wave' });
await sleep(400);
ok('被静音者的聊天/呼叫/动作不再送达', !b2.c.has((m) => m.t === 'msg' && m.m === 'After mute') && !b2.c.has((m) => m.t === 'pg') && !b2.c.has((m) => m.t === 'em'));
me.c.send({ t: 'st', ts: Date.now(), x: 26, y: 2, z: 26, Y: 0, a: {} });
await sleep(250);
ok('但 TA 的人还在世界里走动（静音不是隐身）', b2.c.has((m) => m.t === 'nv' && m.l.some((x) => x.x === 26)));
b2.c.send({ t: 'mu', u: ACCT, on: false });
await sleep(150);
me.c.send({ t: 'ch', m: 'Unmuted' });
ok('解除静音后重新收得到', !!(await b2.c.until((m) => m.t === 'msg' && m.m === 'Unmuted', 2000).catch(() => null)));
// 静音是账号级的：重新登录后仍然生效
b2.c.send({ t: 'mu', u: ACCT });
await sleep(120);
b2.c.ws.close();
const b3 = await join('第二个旅人', B.cookie, 0);
b3.c.inbox.length = 0;
me.c.send({ t: 'ch', m: 'Persist mute' });
await sleep(300);
ok('静音名单跟着账号走，重连后依然屏蔽', !b3.c.has((m) => m.t === 'msg' && m.m === 'Persist mute'));
b3.c.send({ t: 'mu', u: ACCT, on: false });
b3.c.inbox.length = 0;
me.c.send({ t: 'ch', m: 'Persist unmute' });
ok('同一条命令可解除', !!(await b3.c.until((m) => m.t === 'msg' && m.m === 'Persist unmute', 2000).catch(() => null)));
b3.c.ws.close();

// 举报会被记下来（人工处理的入口）
other.c.send({ t: 'rp', u: ACCT, r: '骂人' });
await sleep(200);

// ---------------------------------------------------------------- 星尘成长：余额、等级、图鉴、衣服都在服务端
ok('welcome 下发成长定义（价格不在前端另存一份）', me.welcome.gear?.vit?.cost[0] === 4 && me.welcome.gemCost === 4, JSON.stringify(me.welcome.gear?.vit));
const C = await secondSession();   // 用游客号：账号写入接口按 IP 限流，别再挤占绑定的额度
const g = await join('成长者', C.cookie, 2);   // 单独一条分线：那里的王还活着，星尘来源可控
ok('新账号一切从零开始', g.welcome.prog.gem === 0 && Object.keys(g.welcome.prog.gear || {}).length === 0, JSON.stringify(g.welcome.prog));
g.c.inbox.length = 0;
g.c.send({ t: 'sp', k: 'vit' });
const rej0 = await g.c.until((m) => m.t === 'pr', 2500).catch(() => null);
ok('一枚星尘也没有时升不了级（并把账本推回来）', !!rej0 && rej0.prog.gem === 0 && !rej0.prog.gear?.vit, JSON.stringify(rej0?.prog));
g.c.send({ t: 'kb', d: 8 });
await g.c.until((m) => m.t === 'ws' && m.kh === 8, 2500);
await sleep(250);
g.c.send({ t: 'kb', d: 8 });
const kingPr = await g.c.until((m) => m.t === 'pr' && m.prog.gem === 4, 3000).catch(() => null);
ok('王的最后一跳给 4 枚星尘（鼓励同伴一起磨）', !!kingPr && kingPr.prog.kills === 1, JSON.stringify(kingPr?.prog));
g.c.inbox.length = 0;
g.c.send({ t: 'sp', k: 'vit' });
const up1 = await g.c.until((m) => m.t === 'pr' && m.prog.gear?.vit === 1, 2500).catch(() => null);
ok('升级真的从余额里扣钱', !!up1 && up1.prog.gem === 0, JSON.stringify(up1?.prog));
g.c.send({ t: 'sp', k: 'vit' });     // 没钱了
await sleep(320);
g.c.send({ t: 'sp', k: 'bogus' });   // 没有这条线
await sleep(320);
g.c.send({ t: 'sp', k: 'vit', v: 99 });
await sleep(400);
const mG = await (await fetch(HTTP + '/metrics')).json();
ok('买不起 / 不存在的升级都被挡下并计数', mG.gear_rejected >= 3 && (up1.prog.gear.vit === 1), 'gear_rej=' + mG.gear_rejected);
g.c.send({ t: 'cd', s: 'village' });
const st1 = await g.c.until((m) => m.t === 'pr' && m.prog.gem === 2, 2500).catch(() => null);
ok('第一次打卡记一页并给 2 枚星尘', !!st1 && st1.prog.codex.stamps.includes('village'), JSON.stringify(st1?.prog));
await sleep(650);
g.c.inbox.length = 0;
g.c.send({ t: 'cd', s: 'village' });          // 蹭在同一片草地上
g.c.send({ t: 'cd', s: 'Bad Key!' });         // 非法格式
await sleep(400);
ok('重复与非法的打卡键不加星尘', !g.c.has((m) => m.t === 'pr'), g.c.inbox.map((m) => m.t).join(','));
g.c.inbox.length = 0;
// 换装是穿给别人看的：清洗过的字段广播，脏字段一个都不许出去（anon 与 me 同在 0 线）
me.c.inbox.length = 0; anon.c.inbox.length = 0; other.c.inbox.length = 0;
me.c.send({ t: 'lk', look: { hair: 0x00ff00, style: 'pony', eye: 1e9, top: 0x1234, acc: ['halo', 'staff', 'hat'], bogus: '<img>' } });
const lkb = await anon.c.until((m) => m.t === 'lk', 2500).catch(() => null);
ok('同线同伴当场看到新衣服', !!lkb && lkb.p === me.pid && lkb.look.hair === 0x00ff00 && lkb.look.style === 'pony', JSON.stringify(lkb?.look));
ok('越界颜色被夹住、饰品最多两件、未知字段丢弃',
  !!lkb && lkb.look.top === 0x1234 && lkb.look.eye === 0xffffff && lkb.look.acc.join(',') === 'halo,staff' && !('bogus' in lkb.look), JSON.stringify(lkb?.look));
ok('换装不跨分线广播', !other.c.has((m) => m.t === 'lk') && !g.c.has((m) => m.t === 'lk'));
// 星屑弹是演出件：服务端夹住数值、限流转发，伤害一个字段也不许搭车
me.c.inbox.length = 0; anon.c.inbox.length = 0; other.c.inbox.length = 0;
me.c.send({ t: 'bo', c: 9, Y: 40 });
const bob = await anon.c.until((m) => m.t === 'bo', 2500).catch(() => null);
ok('同线同伴收到这一发（蓄力度与朝向都被夹住，且没有伤害字段）',
  !!bob && bob.p === me.pid && bob.c === 1 && bob.Y === 7 && !('d' in bob) && !('dmg' in bob), JSON.stringify(bob));
const mb0 = await (await fetch(HTTP + '/metrics')).json();
for (let i = 0; i < 8; i++) me.c.send({ t: 'bo', c: i / 8, Y: 1 });
await sleep(420);
const mb1 = await (await fetch(HTTP + '/metrics')).json();
ok('连发星屑弹被限流（每 0.35s 才放行一发）', mb1.bolt_rejected >= mb0.bolt_rejected + 5, 'bolt_rej ' + mb0.bolt_rejected + ' -> ' + mb1.bolt_rejected);
ok('星屑弹不跨分线广播', !other.c.has((m) => m.t === 'bo'));
// 设备上的单机旧账可以认领一次，数值一律封顶、记录不重发奖励
const D = await secondSession();
const d2 = await join('认领者', D.cookie, 3);
d2.c.send({ t: 'sq', gem: 9999, gear: { vit: 9, jump: 3, glide: 2, dmg: 1, shot: 9, bogus: 7 }, stamps: ['lake', 'lake', 'Bad Key', 'feat_king'] });
const clm = await d2.c.until((m) => m.t === 'pr' && m.prog.gem > 0, 2500).catch(() => null);
ok('旧账能被认领，但余额与等级都按上限收', !!clm && clm.prog.gem === 60 && clm.prog.gear.vit === 3 && clm.prog.gear.shot === 3 && !('bogus' in clm.prog.gear), JSON.stringify(clm?.prog));
ok('认领只搬图鉴记录，不重复发星尘', !!clm && clm.prog.codex.stamps.join(',') === 'lake,feat_king', JSON.stringify(clm?.prog.codex));
await sleep(300);
d2.c.inbox.length = 0;
d2.c.send({ t: 'sq', gem: 1, gear: { dmg: 3 } });
await sleep(400);
ok('已经记过账的账号不再接受第二次认领', !d2.c.has((m) => m.t === 'pr'));
// 没有身份就没有账本可改
anon.c.inbox.length = 0;
anon.c.send({ t: 'sp', k: 'vit' });
anon.c.send({ t: 'sq', gem: 30 });
anon.c.send({ t: 'cd', s: 'pier' });
await sleep(400);
ok('匿名连接碰不到成长账本', !anon.c.has((m) => m.t === 'pr'));
// ---- 史莱姆潮：整条分线共用的 PVE。两个人在场才开潮，池子只认服务端那一份
const wsOf = (c) => { for (let i = c.inbox.length - 1; i >= 0; i--) if (c.inbox[i].t === 'ws') return c.inbox[i]; return null; };
const T1 = await secondSession(), T2 = await secondSession();
const t1 = await join('潮伴一', T1.cookie, 3), t2 = await join('潮伴二', T2.cookie, 3);
const wave = await t1.c.until((m) => m.t === 'ws' && m.ta === 1, 4000).catch(() => null);
ok('两个人同线就把潮涌起来了（池子满的、波次从 0 起）', !!wave && wave.tm > 0 && wave.th === wave.tm && wave.tr === 0, JSON.stringify(wave && { tr: wave.tr, tm: wave.tm, th: wave.th }));
ok('一个人守着的分线不会开潮', !other.c.has((m) => m.t === 'ws' && m.ta === 1), JSON.stringify(wsOf(other.c)));
const pool0 = wave ? wave.th : 0;
t1.c.send({ t: 'th', d: 999 });   // 想一跳清空池子：服务端只按 TIDE_HIT 记
t1.c.send({ t: 'th', d: 8 });     // 200ms 内的第二跳不该算
await sleep(700);
const tideW1 = wsOf(t1.c);
ok('进池封顶又限流：连投两跳只扣一跳的钱', !!tideW1 && pool0 - tideW1.th === 8, 'pool ' + pool0 + ' -> ' + (tideW1 && tideW1.th));
let wcur = tideW1 || wave;
for (let i = 0; i < 10 && wcur && wcur.th > 0; i++) {
  t1.c.send({ t: 'th', d: 8 });
  await sleep(230);
  const nw = wsOf(t1.c);
  if (nw) wcur = nw;
}
const done = await t2.c.until((m) => m.t === 'td', 3000).catch(() => null);
ok('池子被打空：全线收到「这一波压下去了」', !!done && done.g === 5 && done.r === 1, JSON.stringify(done));
const prize1 = await t1.c.until((m) => m.t === 'pr' && m.prog.gem >= 5, 3000).catch(() => null);
ok('压波的星尘记到在场每个人头上（不是只给最后一下）', !!prize1 && prize1.prog.gem === 5, JSON.stringify(prize1 && prize1.prog));
const mT0 = await (await fetch(HTTP + '/metrics')).json();
t1.c.send({ t: 'th', d: 8 });
await sleep(320);
const mT1 = await (await fetch(HTTP + '/metrics')).json();
ok('没潮时往池子里投伤害只计数、不扣血', mT1.tide_rejected >= mT0.tide_rejected + 1, 'tide_rej ' + mT0.tide_rejected + ' -> ' + mT1.tide_rejected);
const wave2 = await t1.c.until((m) => m.t === 'ws' && m.ta === 1 && m.tr === 1, 4000).catch(() => null);
ok('下一波要等 TIDE_MS 再来，波次号往前一格', !!wave2 && wave2.th === wave2.tm, JSON.stringify(wave2 && { tr: wave2.tr, th: wave2.th }));
t1.c.ws.close(); t2.c.ws.close();
// ---- 合奏：两个人在同一处做出同一个动作。上行还是那条 em，服务端只多看一眼时间戳与距离
const DU1 = await secondSession(), DU2 = await secondSession();
const du1 = await join('合奏一', DU1.cookie, 3), du2 = await join('合奏二', DU2.cookie, 3);
du1.c.send({ t: 'st', ts: Date.now(), x: 30, y: 2, z: 30, Y: 0, rs: 1, a: {} });
du2.c.send({ t: 'st', ts: Date.now(), x: 30, y: 2, z: 30, Y: 0, rs: 1, a: {} });
await sleep(250);
const gemBase = du1.welcome.prog?.gem | 0;
du1.c.send({ t: 'em', e: 'wave' });
await sleep(200);
du2.c.send({ t: 'em', e: 'heart' });
await sleep(400);
ok('各做各的动作不会合奏', !du1.c.has((m) => m.t === 'du') && !du2.c.has((m) => m.t === 'du'));
await sleep(1200);
du2.c.send({ t: 'st', ts: Date.now(), x: 60, y: 2, z: 60, Y: 0, rs: 1, a: {} });   // 同一个动作，人不在一处
await sleep(200);
du1.c.send({ t: 'em', e: 'spark' });
await sleep(200);
du2.c.send({ t: 'em', e: 'spark' });
await sleep(400);
ok('隔着老远做同一个动作也不算合奏（距离归服务端的位置帧说）', !du1.c.has((m) => m.t === 'du') && !du2.c.has((m) => m.t === 'du'));
await sleep(1200);
du2.c.send({ t: 'st', ts: Date.now(), x: 30, y: 2, z: 30, Y: 0, rs: 1, a: {} });
await sleep(200);
const mD0 = await (await fetch(HTTP + '/metrics')).json();
du1.c.send({ t: 'em', e: 'bow' });
await sleep(250);
du2.c.send({ t: 'em', e: 'bow' });
const duA = await du1.c.until((m) => m.t === 'du', 3000).catch(() => null);
const duB = await du2.c.until((m) => m.t === 'du', 1500).catch(() => null);
ok('同一处做同一个动作：服务端判成合奏，两个人都听见', !!duA && !!duB && duA.e === 'bow' && duA.g === 3 && [duA.a, duA.b].includes(du1.pid) && [duB.a, duB.b].includes(du2.pid), JSON.stringify(duA));
const prize2 = await du1.c.until((m) => m.t === 'pr' && m.prog.gem === gemBase + 3, 3000).catch(() => null);
const prize3 = await du2.c.until((m) => m.t === 'pr' && m.prog.gem === 3, 3000).catch(() => null);
ok('合奏的星尘由服务端记进两个人头上（客户端一分也不加）', !!prize2 && !!prize3, JSON.stringify(prize2 && prize2.prog));
await sleep(1400);
du1.c.send({ t: 'em', e: 'dance' });
await sleep(250);
du2.c.send({ t: 'em', e: 'dance' });
await sleep(500);
const mD1 = await (await fetch(HTTP + '/metrics')).json();
ok('冷却之内动作照样合，但钱不再发，只记一笔被拒', !du1.c.has((m) => m.t === 'du' && m.e === 'dance') && mD1.duet_rejected >= mD0.duet_rejected + 1, 'duet_rej ' + mD0.duet_rejected + ' -> ' + mD1.duet_rejected);
ok('合奏的次数记在 metrics 上', mD1.duets >= mD0.duets + 1, 'duets ' + mD0.duets + ' -> ' + mD1.duets);
du1.c.ws.close(); du2.c.ws.close();
// 衣服跟着账号走：重新连上时优先用档案里那一身，而不是设备默认
me.c.ws.close();
const me2 = await join('阿澄', jar, 0);
ok('重连后仍然穿着账号存的那身（不是客户端默认色）', me2.welcome.look?.hair === 0x00ff00, JSON.stringify(me2.welcome.look));
me2.c.send({ t: 'sp', k: 'jump' });   // 阿澄此刻有 5 星（1 枚碎片 + 王的 4 星）
const jumpPr = await me2.c.until((m) => m.t === 'pr' && m.prog.gear?.jump === 1, 2500).catch(() => null);
ok('第二级线也能买（扣 3 剩 2）', !!jumpPr && jumpPr.prog.gem === 2, JSON.stringify(jumpPr?.prog));
me2.c.send({ t: 'cd', s: 'pier' });
const cdPr = await me2.c.until((m) => m.t === 'pr' && (m.prog.codex?.stamps || []).includes('pier'), 2500).catch(() => null);
ok('打卡写进档案并添两枚星尘', !!cdPr && cdPr.prog.gem === 4, JSON.stringify(cdPr?.prog));
me.c = me2.c; me.pid = me2.pid;   // 后面的用例继续用这个连接

// ---------------------------------------------------------------- 封禁（走 CLI，运维真用的那条路）
ok('CLI 封禁成功', (await cli('ban', '阿澄', '5', '测试')) === 0);
async function tryJoin(cookie) {
  const c = client('banned-try', cookie ? { cookie } : undefined);
  await new Promise((res) => c.ws.addEventListener('open', res, { once: true }));
  c.send({ t: 'hello' });
  await c.until((m) => m.t === 'hello');
  c.send({ t: 'join', r: 'sakura', l: 0, p: { n: '阿澄' } });
  const e = await c.until((m) => m.t === 'err' && m.code === 'banned', 3000).catch(() => null);
  c.ws.close();
  return e;
}
const berr = await tryJoin(jar);
ok('被封账号无法进房', !!berr && berr.until > Date.now(), JSON.stringify(berr));
// 只封账号是不够的：丢掉 cookie 换个匿名连接就该回来了——所以封号时连最近使用的 IP 一起封
const berr2 = await tryJoin(null);
ok('丢 cookie 装作匿名也进不来（连最近使用的 IP 一起封）', !!berr2, JSON.stringify(berr2));
ok('CLI 解封成功', (await cli('unban', '阿澄')) === 0);
const free = await tryJoin(jar);
ok('CLI 解封后可正常进房', free === null);
ok('CLI 能查档案（人工客服用）', (await cli('who', '阿澄')) === 0);
ok('CLI 能看举报', (await cli('reports')) === 0);

// ---------------------------------------------------------------- 重启后还在吗
me.c.ws.close(); anon.c.ws.close(); other.c.ws.close(); b2.c.ws.close();
await sleep(300);
srv?.kill();
await sleep(400);
await boot();
ok('服务端重启（同一库文件）', await waitHealth());
const back = await api('/api/login', { n: '阿澄', p: 'abcdef' });
ok('重启后仍能登录（密码在库里）', back.status === 200 && back.j.a === ACCT);
const j2 = await join('阿澄', back.cookie.split(';')[0], 0);
ok('重启后进度还在', j2.welcome.prog?.shards === 1, JSON.stringify(j2.welcome.prog));
ok('重启后星尘余额与练成等级还在', j2.welcome.prog.gem === 4 && j2.welcome.prog.gear?.jump === 1, JSON.stringify(j2.welcome.prog.gear));
ok('重启后图鉴页还在', (j2.welcome.prog.codex?.stamps || []).includes('pier'), JSON.stringify(j2.welcome.prog.codex));
ok('重启后仍然穿着那一身衣服', j2.welcome.look?.hair === 0x00ff00, JSON.stringify(j2.welcome.look));
ok('重启后世界阶段还在', j2.welcome.world.st === 2, JSON.stringify(j2.welcome.world));
const T3 = await secondSession();
const t3 = await join('潮后客', T3.cookie, 3);
ok('重启后这条分线记得压过几波（波次落库，没打完的池子不跨重启）', (t3.welcome.world?.tr || 0) >= 1 && t3.welcome.world.ta === 0, JSON.stringify(t3.welcome.world));
t3.c.ws.close();
ok('重启后碎片仍不可重复采集', j2.welcome.shards.some((s) => s[0] === 20 && s[1] === 21), JSON.stringify(j2.welcome.shards));
ok('重启后别人的留言与心意还在', j2.welcome.boards.some((b) => b.p === ACCT && b.l === 1), JSON.stringify(j2.welcome.boards));
j2.c.ws.close();

// ---------------------------------------------------------------- 登录保护
jar = '';
for (let i = 0; i < 6; i++) await api('/api/login', { n: '不存在的人', p: 'whatever' });
const locked = await api('/api/login', { n: '阿澄', p: 'abcdef' });
ok('同 IP 连错多次后连正确密码也先拒（防撞库）', locked.status === 429 && locked.j.err === 'locked' && locked.j.retry > 0, JSON.stringify(locked.j));
const h2 = await (await fetch(HTTP + '/healthz')).json();
ok('健康检查暴露库模式与账号数', h2.db === 'file' && h2.accounts.accounts >= 3, JSON.stringify(h2.accounts));

srv?.kill();
console.log(R.join('\n'));
const bad = R.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `ACCOUNT FAIL (${bad}/${R.length})` : `ACCOUNT PASS (${R.length} 项)`);
process.exit(bad ? 1 : 0);
