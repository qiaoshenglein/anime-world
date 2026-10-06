// 存储与账号层的纯逻辑回归（不起服务、不联网，应在 1 秒内跑完）
// 运行: bun test/db-auth.mjs
import { openDb, Store, dayKey } from '../server/db.js';
import { Auth, parseCookie, cookieSet, cookieKill, NAME_RE, jsonBody } from '../server/auth.js';

const R = [];
const ok = (n, c, e) => R.push((c ? 'PASS ' : 'FAIL ') + n + (e ? '  [' + e + ']' : ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mk = () => new Store(openDb('').db);
const s = mk();

// ---- 打开方式
ok('内存模式可用', s.db !== undefined);
const tmpPath = new URL('./.tmp-account.db', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1');
{ const fs = await import('node:fs'); for (const f of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) fs.rmSync(f, { force: true }); } // 上次中断留下的旧 schema 不能污染本次
const fileDb = openDb(tmpPath);
ok('指定路径时走文件模式', fileDb.mode === 'file', fileDb.mode);
const keep = new Store(fileDb.db).createAccount('guest', '存档验证');
const reopen = openDb(fileDb.file);
const rstore = new Store(reopen.db);
ok('文件库能跨实例重开并读回同一账号', reopen.mode === 'file' && rstore.acct(keep.id)?.name === '存档验证', 'mode=' + reopen.mode);
try { await import('node:fs').then((fs) => { for (const f of [reopen.file, reopen.file + '-wal', reopen.file + '-shm']) fs.rmSync(f, { force: true }); }); } catch {}
ok('打不开的路径退回内存', openDb(process.platform === 'win32' ? 'Z:\\nope\\x.db' : '/proc/nope/x.db').mode === 'memory');

// ---- 游客与凭据
const auth = new Auth(s);
const g = auth.guest();
ok('游客自动开号', !!g.account && g.bound === false && g.account.startsWith('a'));
ok('会话能认人', auth.who(g.sid)?.account === g.account);
ok('乱写的会话不认', auth.who('deadbeef') === null && auth.who(null) === null);
const dump = JSON.stringify(s.db.query('select * from sessions').all());
ok('库里只存会话散列，不存明文', !dump.includes(g.sid) && /^[0-9a-f]{64}$/.test(s.st.sessGet.get(auth.store.hash(g.sid)).hash));

// ---- 绑定密码
ok('弱密码被拒', (await auth.bind(g.sid, '新旅人', '123')).err === 'weak');
ok('非法名字被拒', (await auth.bind(g.sid, 'bad <name>', 'abcdef')).err === 'name');
const bnd = await auth.bind(g.sid, '阿澄旅人', 'let-me-in');
ok('绑定成功且沿用同一个号', bnd.bound === true && bnd.account === g.account, JSON.stringify(bnd));
ok('重复绑定被拒', (await auth.bind(g.sid, '阿澄旅人', 'let-me-in')).err === 'already');
const g2 = auth.guest();
ok('名字撞车时后注册者失败', (await auth.bind(g2.sid, '阿澄旅人', 'another-pw')).err === 'taken');

// ---- 登录与锁定
const li = await auth.login('阿澄旅人', 'let-me-in', '1.1.1.1');
ok('密码正确可登录', !!li.sid && li.bound === true);
ok('旧游客会话仍有效（同一账号）', auth.who(g.sid)?.account === g.account);
for (let i = 0; i < 5; i++) await auth.login('阿澄旅人', 'wrong-pw', '2.2.2.2');
const locked = await auth.login('阿澄旅人', 'let-me-in', '2.2.2.2');
ok('连错 5 次后该 IP 被锁，正确密码也先拒', locked.err === 'locked' && locked.retry > 0, JSON.stringify(locked));
ok('没登录过的账号不会泄露存在性', (await auth.login('不存在的人', 'x', '3.3.3.3')).err === 'bad');

// ---- 批量注册节流
let allowed = 0;
for (let i = 0; i < 20; i++) if (auth.throttle('9.9.9.9')) allowed++;
ok('同 IP 开号有频率上限', allowed === 12, 'allowed=' + allowed);
ok('换 IP 不受影响', auth.throttle('8.8.8.8') === true);

// ---- 进度 / 世界 / 碎片
s.saveProgress(g.account, { stage: 3, k0: 2, shards: 17, kills: 8, deaths: 1, plays: 4, wish: 1, upgraded: 1 });
const p = s.progress(g.account);
ok('进度按账号存回', p.stage === 3 && p.shards === 17 && p.upgraded === 1, JSON.stringify(p));
s.bumpPlays(g.account);
ok('游玩次数自增', s.progress(g.account).plays === 5);
s.saveWorld('sakura', 1, { stage: 2, king_hp: 700, king_alive: 1, wish: 0, upgraded: 0 });
s.saveWorld('sakura', 1, { stage: 3, king_hp: 400, king_alive: 0, wish: 1, upgraded: 1 });
s.saveWorld('sakura', 1, { stage: 3, king_hp: 400, king_alive: 0, wish: 1, upgraded: 1, weather: 4, tide_round: 7 });
const w = s.world('sakura', 1);
ok('世界状态按分线独立且可覆写', w.stage === 3 && w.king_alive === 0 && w.upgraded === 1);
ok('天气与已压下的波次都落得进库（没打完的池子不落，是设计）', w.weather === 4 && w.tide_round === 7, JSON.stringify(w));
ok('未初始化的分线有默认世界', s.world('sakura', 3).stage === 0 && s.world('sakura', 3).king_alive === 1);
ok('碎片可被采集一次', s.takeShard('sakura', 1, 12, -8, g.account) === true);
ok('同坐标重复采集被拒（刷碎片失效）', s.takeShard('sakura', 1, 12, -8, g2.account) === false);
ok('别的分线可以重新采', s.takeShard('sakura', 2, 12, -8, g2.account) === true);
ok('碎片清单可回灌', s.shardList('sakura', 1).length === 1 && s.shardCount('sakura', 1) === 1);

// ---- 石碑与点赞（按账号，不按连接）
s.putBoard(g.account, 'sakura', 1, 3, 4, '山顶的风', '阿澄旅人');
const rows = s.boardList('sakura', 1);
ok('留言按账号落库', rows.length === 1 && rows[0].s === '山顶的风' && rows[0].l === 0);
s.putBoard(g.account, 'sakura', 1, 5, 6, '挪了个位置', '阿澄旅人');
ok('一人一块（重刻即挪碑）', s.boardList('sakura', 1).length === 1 && s.board(g.account).s === '挪了个位置');
ok('同一人同一天对同一作者只能点一次', s.markLiked(g.account, g2.account) === true && s.markLiked(g.account, g2.account) === false);
ok('隔日可以再次心动（跨天不永久封心）', s.markLiked(g.account, g2.account, '2000-01-01') === true && s.board(g.account).l === 2);
ok('点赞数按台账累计（同一天同一人只算一颗）', s.board(g.account).l === 2 && s.likeCount(g.account) === 2);
const hearts = s.board(g.account).l;
s.dropBoard(g.account);
ok('收回石碑', s.board(g.account) === null && s.boardList('sakura', 1).length === 0);
s.putBoard(g.account, 'sakura', 1, 8, 9, '重新立碑', '阿澄旅人');
ok('重立碑不会清空既有爱心，也不能刷出新的一颗', s.board(g.account).l === hearts && s.markLiked(g.account, g2.account) === false, 'l=' + s.board(g.account).l);

// ---- 战绩 / 封禁 / 静音 / 举报
s.addPvp(g.account, 3, 12, true);
s.addPvp(g.account, 2, 7, false);
const rec = s.pvpToday(g.account);
ok('当日切磋战绩累计', rec.hits === 5 && rec.dealt === 19 && rec.wins === 1, JSON.stringify(rec));
ok('换天另起一笔', s.pvpToday(g.account, '2000-01-01').hits === 0);
ok('封禁生效并可解除', s.banned(g2.account) === null && (s.ban(g2.account, 10, '刷广告'), s.banned(g2.account)?.reason === '刷广告') && (s.unban(g2.account), s.banned(g2.account) === null));
s.ban(g2.account, 1);
s.ban(g2.account, 0, '已过期');
ok('过期的封禁不算封禁', s.banned(g2.account) === null && s.banList().length === 0);
s.mute(g.account, g2.account);
s.mute(g.account, g.account);
ok('静音名单可查且不能静音自己', [...s.mutes(g.account)].join() === g2.account && s.mutes(g2.account).size === 0);
s.unmute(g.account, g2.account);
ok('可解除静音', s.mutes(g.account).size === 0);
s.report(g2.account, g.account, '骂人');
s.report(g2.account, g.account, 'x'.repeat(400));
const rp = s.reports();
ok('举报入库并截断', rp.length === 2 && rp.every((x) => x.reason.length <= 120) && rp.some((x) => x.reason.length === 120));
ok('总览统计可查', s.counts().accounts >= 2 && s.counts().bound >= 1, JSON.stringify(s.counts()));

// ---- 边界与请求体
ok('名字白名单：挡尖括号与控制字符', !NAME_RE.test('<script>') && !NAME_RE.test('a\nb') && NAME_RE.test('阿澄·旅人') && NAME_RE.test('Fisher_9'));
ok('名字长度上限', !NAME_RE.test('字'.repeat(17)));
const cs = cookieSet('abc');
ok('凭据 Cookie 是 HttpOnly + Lax', /HttpOnly/.test(cs) && /SameSite=Lax/.test(cs) && /Max-Age=/.test(cs));
ok('退出用的 Cookie 立即过期', /Max-Age=0/.test(cookieKill()));
ok('Cookie 解析正确', parseCookie(new Request('http://x/', { headers: { cookie: 'a=1; ' + 'aw_sid=xyz; b=%202' } })).aw_sid === 'xyz');
async function body(ct, text) { return jsonBody(new Request('http://x/api', { method: 'POST', headers: { 'content-type': ct }, body: text })); }
ok('只吃 JSON：表单与纯文本被拒', (await body('application/x-www-form-urlencoded', '{"a":1}').catch((e) => e.message)).includes('json'));
ok('超大请求体被拒', String(await body('application/json', '{"a":"' + 'y'.repeat(9000) + '"}').catch((e) => e.message)).includes('过大'));
ok('数组或标量不算合法对象', String(await body('application/json', '[1,2]').catch((e) => e)).includes('格式'));
ok('日期分片键稳定', dayKey(Date.now()).length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(dayKey()));

// ---- 天气规则表：一条分线的天也决定这条线的规矩
const wx = await import('../server/weather.js');
ok('五种天的顺序写死在这一处', wx.WEATHER.join(',') === 'clear,petal,rain,fog,meteor');
ok('细雨里一枚星屑给两撇星尘', wx.shardGem(wx.W.rain) === 2 && wx.shardGem(wx.W.clear) === 1 && wx.shardGem(wx.W.petal) === 1);
ok('只有流星夜的许愿多给两撇', wx.wishGem(wx.W.meteor) === 2 && wx.wishGem(wx.W.clear) === 0 && wx.wishGem(wx.W.rain) === 0);
ok('樱吹雪把滑翔的消耗托到 55%，别的天不托', wx.glideMul(wx.W.petal) === 0.55 && wx.glideMul(wx.W.clear) === 1 && wx.glideMul(wx.W.fog) === 1);
ok('薄雾里白鹿只在 3.2 米内才躲，而且愿意带路', wx.deerFlee(wx.W.fog) === 3.2 && wx.deerFlee(wx.W.clear) === 9 && wx.deerGuides(wx.W.fog) === true && wx.deerGuides(wx.W.rain) === false);
ok('认不得的天气编号按最保守的算（不会凭空多发星尘）', wx.shardGem(99) === 1 && wx.wishGem(-1) === 0 && wx.glideMul(99) === 1 && wx.deerFlee(99) === 9 && wx.deerGuides(99) === false);

console.log(R.join('\n'));
const bad = R.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `DB/AUTH FAIL (${bad}/${R.length})` : `DB/AUTH PASS (${R.length} 项)`);
process.exit(bad ? 1 : 0);
