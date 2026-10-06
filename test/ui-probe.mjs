// 真浏览器端到端探针：把打包好的 index.html 复制成 ui-probe.html，追加一段驱动脚本，
// 用 headless Chrome + --dump-dom 读回结果。验证的是「玩家真点得到的那条路」：
// 游客号 cookie → 面板显示 → 绑定 → 退出 → 凭昵称密码登录回同一个号 → 权威进度回灌。
// 运行: bun test/ui-probe.mjs   （需要本机 Chrome；软件 WebGL 下先把渲染尺寸压到极小）
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { startServer } from './spawn.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1');
const DB = ROOT + 'test/.tmp-probe.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) rmSync(f, { force: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const S = await startServer(ROOT, { AW_DB: DB, CHAT_RATE: '20' }, { tag: 'probe', stderr: 'pipe' });
if (!existsSync(CHROME)) {
  console.log('SKIP：本机没有 Chrome（' + CHROME + '），浏览器流程未验证');
  S.proc.kill();
  process.exit(0);
}

const probe = `<script>
(function () {
  const R = [];
  const TRACE = [];
  window.addEventListener('error', (e) => R.push('FAIL 页面异常 [' + e.message + ' @ ' + String(e.filename).slice(-24) + ':' + e.lineno + ':' + e.colno + ']'));
  const ok = (n, c, e) => R.push((c ? 'PASS ' : 'FAIL ') + n + (e ? '  [' + e + ']' : ''));
  const out = () => {
    let p = document.getElementById('probeOut');
    if (!p) { p = document.createElement('pre'); p.id = 'probeOut'; p.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#000;font:11px monospace;margin:0;padding:4px'; document.body.appendChild(p); }
    p.textContent = R.join('\\n');
    document.title = 'PROBEDONE ' + R.filter((x) => x.startsWith('FAIL')).length;
    // 结果写好后让主循环停下：否则游戏帧会继续吃满 --virtual-time-budget，把一次 10 秒的验证拖成一分钟
    try { window.__game.G.state = 'loading'; } catch (e) {}
    try { fetch('/metrics').then((r) => r.json()).then((j) => { p.textContent += '\\nREAL ' + j.uptime_s + 's online=' + j.online + ' ticks=' + seq; }).catch(() => {}); } catch (e) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 关键：headless 的 --virtual-time-budget 会让纯 setTimeout 轮询瞬间烧完，
  // 服务端 5Hz 的世界快照下发（真实时间 200ms）根本来不及。每轮先做一次真实网络往返，虚拟时间只能等它。
  let seq = 0;
  const tick = async () => {
    try { await fetch('/healthz?_=' + (++seq)); } catch (e) {}
    await sleep(20);
  };
  // 软件渲染下一帧很贵：只在真的需要世界动起来的时候手动补帧，别在每个等待循环里都跑一遍
  const frame = () => { if (g().step) g().step(); else { try { g().net.tick(g().P, g().G, 1 / 60); } catch (e) {} } };
  const drain = async (n) => { for (let i = 0; i < n; i++) { frame(); await tick(); } };
  // 页面变小后虚拟时钟跑得比服务端定时器快得多：判断「等不到」必须看服务端的真实秒数，不能看页内的 Date.now()
  const up = async () => { try { return (await (await fetch('/metrics')).json()).uptime_s; } catch (e) { return 0; } };
  const until = async (pred, _ms, secs) => {
    secs = secs || 2;
    const r0 = await up();
    for (let n = 0; n < 800; n++) {
      try { if (pred()) return true; } catch (e) {}
      await tick();
      const r1 = await up();
      if (r1 - r0 >= secs) { try { return !!pred(); } catch (e) { return false; } }
    }
    return false;
  };
  // 虚拟时钟下的 Date.now() 不走得和墙上时钟一样快，凡是要等「服务端限流 + 本地几帧」的事都按次数泵，不按时间
  const pump = async (pred, steps) => {
    for (let i = 0; i < steps; i++) { try { if (pred()) return true; } catch (e) {} frame(); await tick(); }
    try { return !!pred(); } catch (e) { return false; }
  };
  const g = () => window.__game;
  const click = (id) => document.getElementById(id).click();
  const setv = (id, v) => { document.getElementById(id).value = v; };
  const line = () => document.getElementById('acctLine').textContent;
  const stats = () => document.getElementById('acctStats').textContent;
  const shown = (id) => !document.getElementById(id).classList.contains('hidden');
  (async () => {
    if (!(await until(() => g() && g().net, 0, 30))) { ok('探针拿到调试入口', false); return out(); }
    try { g().renderer.setSize(4, 4, false); } catch (e) {}   // 软件 WebGL：把每帧成本压到几个像素
    // 线上轨迹：出问题时报文有没有往来说清楚
    const _s = g().net._send.bind(g().net);
    g().net._send = (o) => { TRACE.push('>' + o.t); _s(o); };
    const _m = g().net._onMsg.bind(g().net);
    g().net._onMsg = (raw) => { try { TRACE.push('<' + JSON.parse(raw).t); } catch (e) {} _m(raw); };
    if (!(await until(() => shown('title'), 0, 45))) { ok('标题页出现（世界加载完）', false, 'title 仍隐藏'); return out(); }
    ok('标题页出现（世界加载完）', true);

    // 舒适设置必须在进世界之前就能调 —— 玩家不该靠忍着去试
    click('setBtn');
    await sleep(60);
    ok('标题页就能打开设置面板', shown('set'));
    ok('滑杆与开关都建出来了', document.querySelectorAll('#setRows .srow').length >= 9, 'rows=' + document.querySelectorAll('#setRows .srow').length);
    const shakeIn = document.querySelector('#setRows input[data-key=shake]');
    shakeIn.value = 0;
    shakeIn.dispatchEvent(new Event('input'));
    await sleep(60);
    ok('镜头震动能一键归零并落盘', JSON.parse(localStorage.getItem('aw.settings') || '{}').shake === 0);
    const fovIn = document.querySelector('#setRows input[data-key=fov]');
    fovIn.value = 70;
    fovIn.dispatchEvent(new Event('input'));
    await sleep(120);
    ok('视野滑杆即刻改到相机上', Math.abs(g().camera.fov - 70) < 0.6, 'fov=' + g().camera.fov);
    click('setClose');
    ok('设置面板可关闭', await until(() => !shown('set'), 0, 3));

    click('joinBtn');
    ok('连线后自动带上游客号身份（cookie 真的走通了）', await until(() => g().net.me && g().net.me.a, 0, 10), JSON.stringify(g().net.me));
    const ACCT = g().net.me && g().net.me.a;

    click('acctBtn');
    ok('档案面板能打开', shown('acct'));
    ok('面板显示游客号状态与战绩', /游客号/.test(line()) && /碎片 0 枚/.test(stats()), line() + ' | ' + stats());

    setv('acctName', '探针君'); setv('acctPass', 'probe-pass');
    click('bindBtn');
    ok('绑定后就地转正并刷新面板', await until(() => g().net.me.bound === true && /已绑定/.test(line()), 0, 12), line());
    ok('绑定后密码框禁用（不能被再改一遍）', document.getElementById('acctPass').disabled === true);

    click('startBtn');
    await sleep(500);
    ok('进入游戏后联机界面可见', shown('netbar'));
    await drain(24);   // 先让世界跑几十帧：同步王血、贴天气、开图鉴这些都要有帧
    ok('权威世界快照进了客户端', await until(() => { const w = g().net.world; return w && w.kingMax === 60; }, 0, 5), JSON.stringify(g().net.world));
    ok('王的血量上限跟着服务端走（不是本地 26）', await until(() => {
      const k = g().enemies.find((e) => e.king && !e.dead);
      return k && k.maxHp === 60 && k.hp === 60;
    }, 0, 6), (() => { const k = g().enemies.find((e) => e.king); return k ? k.hp + '/' + k.maxHp : 'no king'; })());
    click('acctBtn');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await sleep(200);
    ok('Esc 关掉档案面板', !shown('acct'));

    g().setStage(1);
    ok('任务推进经服务端回灌', await until(() => g().net.world.stage === 1, 0, 5), JSON.stringify(g().net.world));
    const P = g().P;
    g().net.take(P.pos.x, P.pos.z);
    ok('采碎片上报后被服务端记进 taken', await until(() => g().net.taken.size >= 1, 0, 5));
    ok('面板战绩同步到 1 枚', await until(() => /碎片 1 枚/.test(stats()), 0, 6), stats());
    if (R[R.length - 3].startsWith('FAIL') || R[R.length - 1].startsWith('FAIL')) { ok('  线上轨迹', false, TRACE.join(' ').slice(-600)); }

    // ---- 旅人之书：星尘成长（点击 → 服务端扣账 → 回灌 → 手感当场变）
    // 村口就在出生点边上：走近自动翻页，服务端记一页给 2 星尘——这就是「走到就记下」的验证
    ok('走过村口自动翻开图鉴（并由服务端记账）', await pump(() => (g().net.prog?.codex?.stamps || []).includes('village'), 130),
      'srv=' + JSON.stringify(g().net.prog?.codex) + ' local=' + JSON.stringify(g().COD) + ' pos=' + Math.round(g().P.pos.x) + ',' + Math.round(g().P.pos.z) + ' gem=' + g().GR.gem + ' trace=' + TRACE.slice(-40).join(' '));
    click('bookBtn');
    await sleep(80);
    ok('旅人之书能翻开', shown('book'));
    const grows = [...document.querySelectorAll('#bookBody .gearrow')];
    ok('成长页列出五条线', grows.length === 5, 'rows=' + grows.length);
    ok('余额写明由世界记账', /星尘 [0-9]+ 枚/.test(document.getElementById('bookGem').textContent) && /由世界记账/.test(document.getElementById('bookGem').textContent), document.getElementById('bookGem').textContent);
    const KEYS = ['vit', 'jump', 'glide', 'dmg', 'shot'];
    const NUMS = { vit: () => g().P.maxHp, jump: () => g().P.jumpV, glide: () => g().P.glideDrain, dmg: () => g().P.dmgBonus, shot: () => g().P.shotDmg };
    const btns = grows.map((r) => r.querySelector('button'));
    const costs = btns.map((b) => parseInt(b.textContent, 10));
    const gem0 = g().GR.gem;
    ok('买不起的标成灰、买得起的亮着', btns.every((b, i) => b.disabled === (costs[i] > gem0)), JSON.stringify(costs) + ' gem=' + gem0);
    const lit = costs.findIndex((c) => c <= gem0 && KEYS[costs.indexOf(c)] === 'jump');
    ok('此刻有一条练得起的线', lit >= 0, 'gem=' + gem0);
    if (lit >= 0) {
      const num0 = KEYS.map((k) => NUMS[k]());
      btns[lit].click();
      ok('练成一级由服务端扣账', await pump(() => g().GR.gear[KEYS[lit]] === 1 && g().GR.gem === gem0 - costs[lit], 70), JSON.stringify(g().GR));
      ok('练成的那项在身上的数值立刻变了', NUMS[KEYS[lit]]() !== num0[lit], KEYS[lit] + ': ' + num0[lit] + ' -> ' + NUMS[KEYS[lit]]());
      const litRow = [...document.querySelectorAll('#bookBody .gearrow')][lit]; // 面板刚被 renderBook 重建成新节点，旧引用不能再用
      ok('余额与格子跟着刷新', /星尘 [0-2] 枚/.test(document.getElementById('bookGem').textContent) && litRow.querySelectorAll('.pips i.on').length === 1, document.getElementById('bookGem').textContent);
    }
    document.querySelector('#bookTabs [data-tab=stamps]').click();
    ok('图鉴自动记下走过的地方', /始源之村/.test(document.getElementById('bookBody').textContent), document.getElementById('bookBody').textContent.slice(0, 40));
    document.querySelector('#bookTabs [data-tab=wardrobe]').click();
    const kids0 = g().scene.children.length;
    const sw = document.querySelectorAll('#bookBody .swatches i')[4];
    sw.click();
    ok('换发色立刻重建角色网格', await until(() => g().LK.hair === 0x6affd4 && g().char.opts.hair === 0x6affd4, 0, 3), JSON.stringify(g().LK && g().LK.hair));
    ok('外观落进这台设备（下次开页还是这身）', JSON.parse(localStorage.getItem('aw.look') || '{}').hair === 0x6affd4);
    ok('旧角色被收走而不是叠在场景里', g().scene.children.length === kids0, kids0 + ' -> ' + g().scene.children.length);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await sleep(120);
    ok('Esc 关掉旅人之书', !shown('book'));

    // ---- 世界生机：分线天气 / 烟花 / 新表情
    const wxText = () => document.getElementById('wx').textContent;
    ok('小地图旁写着这条分线的天气', /晴|樱吹雪|细雨|薄雾|流星夜/.test(wxText()), wxText());
    const fog0 = g().scene.fog.far;
    g().net.world.weather = 2;                       // 当作服务端把「细雨」推了过来（真值下发由账号套件在协议层验）
    await pump(() => wxText() === '细雨' && g().scene.fog.far < fog0 - 40, 80);
    ok('收到别的天气会慢慢变过去（雾变近、字跟着换）', wxText() === '细雨' && g().scene.fog.far < fog0 - 40, wxText() + ' fog=' + Math.round(g().scene.fog.far));
    click('setBarBtn');
    await sleep(80);
    const tog = [...document.querySelectorAll('#setRows [data-tog]')].find((b) => /天气/.test(b.textContent));
    ok('设置里有「分线天气」开关', !!tog, tog && tog.textContent);
    tog.click();
    ok('关掉天气立刻回到晴空（有人只想要安静）', await pump(() => wxText() === '晴', 40), wxText());
    await pump(() => g().scene.fog.far > fog0 - 60, 90);
    ok('雾也慢慢退回去', g().scene.fog.far > fog0 - 60, 'fog=' + Math.round(g().scene.fog.far));
    tog.click();
    await sleep(40);
    click('setClose');
    const fwAt = TRACE.length;
    await drain(170);   // 让本地的烟花冷却（2.5s 游戏时间）先过去，否则这一按会被自己的闸门吞掉
    const alive = () => { let n = 0; for (const x of g().particles.life) if (x > 0) n++; return n; };
    const p0 = alive();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true }));
    ok('F 放烟花会通知同线的同伴', TRACE.slice(fwAt).includes('>fw'), TRACE.slice(fwAt, fwAt + 4).join(' '));
    ok('烟花当场炸开了一片光点', alive() - p0 > 60, 'p=' + (alive() - p0));
    const emAt = TRACE.length;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit5', bubbles: true }));
    await sleep(60);
    ok('按 5 真的鞠了一躬（有动作也有广播）', TRACE.slice(emAt).includes('>em') && !!g().P.gest, TRACE.slice(emAt, emAt + 3).join(' ') + ' gest=' + JSON.stringify(g().P.gest));
    await pump(() => !g().P.gest, 110);
    ok('鞠躬做完就起身（不会永远弯着）', !g().P.gest);
    ok('林子里有白鹿在走', Array.isArray(g().deer) && g().deer.length === 4 && g().deer.every((d) => d.root && d.legs.length === 4), 'deer=' + (g().deer && g().deer.length));
    ok('夜里会亮起菌子', !!g().shrooms && g().shrooms.mesh.count > 0, 'shrooms=' + (g().shrooms && g().shrooms.mesh.count));

    // ---- 星屑弹：按住 R 蓄满 → 松手放出 → 打中面前那只，全程镜头一动不动
    // 探针里每一帧都要一次真实网络往返，所以「蓄满」是把蓄力时长调短，而不是空等五十帧
    g().cam.yaw = 0;                                     // 镜头朝北，蓄力时身体会慢慢转向它
    const tgt = g().spawn(g().P.pos.x, g().P.pos.z - 6, 'green'); // 就在身前六米，索敌必然抓得到
    const hp0 = tgt.hp, shotAt = TRACE.length, shake0 = g().G.shakeAmt;
    g().P.stamina = 2;                                   // 先空着手试一次：这一发是按体力计价的
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
    await drain(2);
    ok('没力气就蓄不起这一发', !g().P.shot && !shown('charge'));
    g().P.stamina = 100;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
    await drain(4);
    ok('按住 R 开始蓄力（条子亮起来，弹还没出手）', !!g().P.shot && shown('charge') && g().P.shot.c > 0 && !TRACE.slice(shotAt).includes('>bo'),
      'c=' + (g().P.shot && g().P.shot.c.toFixed(2)));
    g().P.chargeT = 0.05;
    await drain(4);
    ok('蓄满时条子走到头并转成金色', g().P.shot === null || g().P.shot.c >= 0.99, 'c=' + (g().P.shot && g().P.shot.c));
    ok('满蓄的条子换成金色', document.getElementById('charge').classList.contains('full'));
    let shakeAtHit = -1;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', bubbles: true }));
    await drain(1);
    const stAfter = g().P.stamina;                      // 出手那一帧就读走：体力会自己回，晚了就看不出扣了多少
    ok('松手才放出去，并通知同线的同伴', TRACE.slice(shotAt).includes('>bo'), TRACE.slice(shotAt, shotAt + 4).join(' '));
    await pump(() => {
      if (tgt.hp < hp0 || tgt.dead) { shakeAtHit = g().G.shakeAmt; return true; }
      return false;
    }, 40);
    ok('星屑弹真的打中了远处的那只', tgt.hp < hp0 || tgt.dead, 'hp ' + hp0 + ' -> ' + tgt.hp + ' dead=' + tgt.dead);
    ok('远程攻击不震屏（容易晕的人也能安心放弹）', shakeAtHit >= 0 && shakeAtHit <= shake0 + 0.02, 'shake ' + shake0 + ' -> ' + shakeAtHit);
    ok('这一发按体力计价（满蓄 12 点）', stAfter < 90, 'st=' + Math.round(stAfter));
    ok('穿一个就碎（Lv0 的满蓄只穿一个目标）', g().shots.length === 0, 'shots=' + g().shots.length);
    g().P.chargeT = 0.85; g().P.stamina = 100;

    // ---- 史莱姆潮：探针一个人，就把服务端快照当成「这条线已经开潮」来演（协议层由账号套件验）
    g().net.world.tideAlive = true; g().net.world.tideMax = 40; g().net.world.tideHp = 40; g().net.world.tideRound = 0;
    ok('开潮后身边真的涌出潮水史莱姆', await pump(() => g().enemies.filter((e) => e.tide && !e.dead).length === 5, 60),
      'tide=' + g().enemies.filter((e) => e.tide).length);
    ok('屏幕上方出现这一波的池子条', await pump(() => !document.getElementById('tide').classList.contains('hidden') && /第 1 波/.test(document.getElementById('tidetxt').textContent), 20),
      document.getElementById('tidetxt').textContent);
    const tb = g().enemies.find((e) => e.tide && !e.dead);
    const tbHp0 = tb.hp, thAt = TRACE.length;
    g().P.invuln = 6; g().P.hp = 100;                    // 五只潮水围着，先免伤才谈得上「这一刀是我砍的」
    g().P.pos.set(tb.pos.x, tb.pos.y, tb.pos.z + 1.2);   // 贴到它跟前，省得追半天
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', bubbles: true }));
    await pump(() => tb.hp < tbHp0, 30);
    ok('砍中潮水时本地掉血、也往这条分线的池子里投了一跳', tb.hp < tbHp0 && TRACE.slice(thAt).includes('>th'), TRACE.slice(thAt, thAt + 6).join(' '));
    const tideAt = TRACE.length, pT0 = alive();
    g().net._onMsg(JSON.stringify({ t: 'td', r: 1, g: 5 }));
    await drain(8);
    ok('压下一波会替全线放烟花，并记下图鉴的一页', alive() - pT0 > 40 && g().COD.includes('feat_tide') && TRACE.slice(tideAt).includes('>cd'),
      'p+=' + (alive() - pT0) + ' codex=' + g().COD.slice(-2).join(','));
    g().net.world.tideAlive = false;
    ok('潮退了：散兵变回普通史莱姆，池子条也收走', await pump(() => g().enemies.every((e) => !e.tide || e.dead) && document.getElementById('tide').classList.contains('hidden'), 20),
      'tide=' + g().enemies.filter((e) => e.tide).length);

    // ---- 天气也是规则：雾起的这条线上，白鹿不躲人，还朝没被采走的星屑走过去
    const d0 = g().deer[0];
    d0.root.position.set(g().P.pos.x + 5, d0.root.position.y, g().P.pos.z);   // 五米外站着一只：平时这个距离它早走了
    d0.rest = 0;
    g().net.world.weather = 3;
    ok('薄雾里白鹿不惧人，并且开始朝一枚未采的星屑走', await pump(() => d0.flee === 0 && d0.guideT > 0 && d0.gx != null, 40),
      'flee=' + d0.flee + ' guide=' + d0.gx + ',' + d0.gz + ' tx=' + Math.round(d0.tx) + ',' + Math.round(d0.tz));
    ok('变天时会说一句这天能做什么', /薄雾/.test(document.getElementById('toasts').textContent) && /白鹿/.test(document.getElementById('toasts').textContent),
      document.getElementById('toasts').textContent.slice(0, 60));
    g().net.world.weather = 0;

    // ---- 合奏：两个人在同一处做出同一个动作。判定与发钱都在服务端，客户端只负责让天上响一声
    const fw0 = g().fwSeen, shake0 = g().G.shakeAmt, myPid = g().net.pid;
    const duetAt = TRACE.length;
    g().net._onMsg(JSON.stringify({ t: 'du', a: myPid, b: 'p-other', na: '探针君', nb: '同伴甲', e: 'bow', x: 4, z: 4, g: 1 }));
    await drain(10);
    const tt1 = document.getElementById('toasts').textContent;
    ok('自己参与的合奏会在两人脚下放一朵烟花并说一句人话', g().fwSeen > fw0 && /合奏 · 你和 同伴甲/.test(tt1) && /✦\+1/.test(tt1), tt1.slice(0, 70));
    ok('合奏记进入图鉴的一页', g().COD.includes('feat_duet'), JSON.stringify(g().COD.slice(-3)));
    ok('合奏不多占带宽：不放上行烟花，只记一页图鉴', !TRACE.slice(duetAt).includes('>fw') && TRACE.slice(duetAt).includes('>cd'), TRACE.slice(duetAt, duetAt + 6).join(' '));
    ok('合奏不动镜头（容易晕的人的硬约束）', g().G.shakeAmt <= shake0 + 0.001, 'shake ' + shake0 + ' -> ' + g().G.shakeAmt);
    const fw1 = g().fwSeen, feats0 = g().COD.length;
    g().net._onMsg(JSON.stringify({ t: 'du', a: 'p-x', b: 'p-y', na: '路人甲', nb: '路人乙', e: 'dance', x: -3, z: 6, g: 1 }));
    await drain(10);
    const tt2 = document.getElementById('toasts').textContent;
    ok('旁观别人的合奏只听见那两个名字，不记自己的页', g().fwSeen > fw1 && /路人甲 与 路人乙/.test(tt2) && g().COD.length === feats0, tt2.slice(-70));

    click('logoutBtn');
    ok('退出后身份即刻变匿名（重连换 cookie）', await until(() => g().net.me === null, 0, 12), JSON.stringify(g().net.me));
    setv('acctName', '探针君'); setv('acctPass', 'probe-pass');
    click('loginBtn');
    await sleep(1500);
    ok('凭昵称密码登录找回同一个账号', await until(() => g().net.me && g().net.me.a === ACCT, 0, 12),
      'acct=' + JSON.stringify(g().net.acct) + ' trace=' + TRACE.slice(-260).join(' '));
    ok('重新登录后旅程还在', await until(() => g().net.world && g().net.world.stage === 1 && g().net.prog && g().net.prog.shards >= 1, 0, 8),
      JSON.stringify(g().net.prog));
    out();
  })().catch((e) => { ok('探针没炸', false, e.message + ' @ ' + (e.stack || '').split('\\n')[1]); out(); });
})();
</script>
`;
const html = readFileSync(ROOT + 'index.html', 'utf8').replace('</body>', probe + '</body>');
writeFileSync(ROOT + 'ui-probe.html', html);

const args = [
  '--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox',
  '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + ROOT + 'test/.tmp-chrome', '--window-size=200,150',
  '--virtual-time-budget=2400000', '--timeout=45000', '--dump-dom',
  S.base + '/ui-probe.html',
];
const t0 = Date.now();
const p = Bun.spawn([CHROME, ...args], { stdout: 'pipe', stderr: 'ignore' });
const dom = await new Response(p.stdout).text();
await p.exited;
const m = dom.match(/id="probeOut"[^>]*>([\s\S]*?)<\/pre>/);
if (!m) console.log('(没有探针输出，' + ((Date.now() - t0) / 1000).toFixed(1) + 's) —— 页面可能没能起来');
else console.log(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
S.proc.kill();
await S.proc.exited.catch(() => {}); // 等它真的退出再删库：Windows 上进程还握着文件时 rm 会 EBUSY
rmSync(ROOT + 'ui-probe.html', { force: true });
for (const f of [DB, DB + '-wal', DB + '-shm']) rmSync(f, { force: true });
rmSync(ROOT + 'test/.tmp-chrome', { recursive: true, force: true }); // 探针专用 Chrome 配置，用完就走
const fails = m ? (m[1].match(/FAIL/g) || []).length : 1;
console.log(fails ? 'UI PROBE FAIL (' + fails + ')' : 'UI PROBE PASS');
process.exit(fails ? 1 : 0);
