// 联机 UI 接线位置回归检查：监听必须在标题页出现时就绪。
// 曾因 netInit() 只在「开始冒险」回调里调用，导致标题页点「连线同行」毫无反应。
// 运行: bun test/ui-wiring.mjs
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1');
const src = readFileSync(ROOT + 'src/main.js', 'utf8');
const tpl = readFileSync(ROOT + 'index.template.html', 'utf8');
const R = [];
const ok = (n, c, e) => R.push((c ? 'PASS ' : 'FAIL ') + n + (e ? '  [' + e + ']' : ''));

const titleAt = src.indexOf("G.state = 'title'");
ok('找到标题页进入点', titleAt > 0);
// 顺序陷阱：mpSync() 依据 G.state 决定界面，必须先置为 play 再同步
const startAt = src.indexOf("$('startBtn').addEventListener");
const startBlock = src.slice(startAt, startAt + 420);
const iState = startBlock.indexOf("G.state = 'play'");
const iSync = startBlock.indexOf('mpSync()');
ok('开始冒险：先置 play 再同步联机界面', iState > 0 && iSync > iState, `play@${iState} mpSync@${iSync}`);
const window2 = src.indexOf("G.state = 'play'", titleAt);
const titleBlock = src.slice(titleAt, window2 > 0 ? window2 : titleAt + 600);
ok('标题页出现时即完成联机接线', /netInit\(\)/.test(titleBlock), titleBlock.split('\n').slice(0, 6).join(' / ').slice(0, 120));
ok('开始冒险时保持同步联机界面', /startBtn[\s\S]{0,420}mpSync\(\)/.test(src));

// 联机控件必须齐备（缺一个就会静默失效）
for (const id of ['joinBtn', 'nameIn', 'srvIn', 'netbar', 'nstat', 'nonline', 'mpBox', 'mpHint', 'chatIn', 'chSend'])
  ok('模板含 #' + id, tpl.includes('id="' + id + '"'));
for (const id of ['joinBtn', 'nameIn', 'srvIn', 'nstat', 'nonline', 'mpBox', 'mpHint', 'chatIn', 'chSend', 'netbar', 'leaveBtn', 'chToggle', 'chat'])
  ok('main.js 引用 #' + id, src.includes("$('" + id + "')"));

// 连线不得只在游戏内进行：joinBtn 处理器应调用 connect 并刷新界面
const joinAt = src.indexOf("$('joinBtn').addEventListener");
ok('joinBtn 处理器存在', joinAt > 0);
const joinBlock = src.slice(joinAt, joinAt + 520);
ok('点击即发起连接', /net\.connect\(/.test(joinBlock));
ok('点击后立刻刷新界面反馈', /mpSync\(\)/.test(joinBlock));
ok('不再无条件隐藏连线面板', !/\$\('mpBox'\)\.classList\.add\('hidden'\)/.test(joinBlock));

// ---- 移动端全屏控件
ok('模板含 #fsBtn', tpl.includes('id="fsBtn"'));
ok('fsBtn 是语义按钮', /<button[^>]*id="fsBtn"/.test(tpl));
ok('fsBtn 位于触摸层内', tpl.indexOf('id="fsBtn"') > tpl.indexOf('id="touch"'));
ok('全屏按 click 绑定（保证用户手势授权）', /\$\('fsBtn'\)|el\.addEventListener\('click'/.test(src) && src.includes("el.addEventListener('click'"));
ok('兼容 webkit 前缀', src.includes('webkitRequestFullscreen') && src.includes('webkitExitFullscreen'));
ok('不支持时降级提示而非静默', src.includes('不支持网页全屏'));
ok('全屏切换后重算画布尺寸', /setTimeout\(resize, ?\d+\)/.test(src));
ok('安全区避让（刘海/圆角）', tpl.includes('env(safe-area-inset-right)') && tpl.includes('viewport-fit=cover'));

// ---- 暂停已移除：失去鼠标锁定不得冻结世界，只能切到光标模式
ok('模板不再有暂停面板', !tpl.includes('id="pause"'));
ok('源码不再残留 paused 状态', !/\bG\.paused\b/.test(src) && !/paused:/.test(src));
ok('Esc/解锁不会冻结逻辑', !/paused = true/.test(src));
const lockBlock = src.slice(src.indexOf("document.addEventListener('pointerlockchange'"), src.indexOf("document.addEventListener('pointerlockerror'"));
ok('解锁后自动进入光标模式而非静默卡死', /setCursor\(true, ?true\)/.test(lockBlock), lockBlock.replace(/\n\s*/g, ' ').slice(0, 120));
ok('Tab 可切换光标模式', /KeyTab|'Tab'/.test(src) && /setCursor\(!G\.cursor\)/.test(src));
ok('边缘转向带死区与平滑', /steer\.overUi/.test(src) && /steer\.curYaw = lerp/.test(src));
ok('光标模式下转向不受界面遮挡影响误触发', /steer\.overUi \? 0 : steer\.yaw/.test(src));

// ---- 玩家互动：每个入口都必须真的绑上
for (const id of ['emBtn', 'pvBtn', 'pgBtn', 'modeBtn', 'emoteRow']) ok('模板含 #' + id, tpl.includes('id="' + id + '"'));
const niAt = src.indexOf('function netInit()');
const netInitBlock = src.slice(niAt, src.indexOf('\nfunction pushChat', niAt));
for (const [id, fn] of [['emBtn', "toggle\\('hidden'\\)"], ['pvBtn', 'togglePvp'], ['pgBtn', 'sendPing'], ['modeBtn', 'setCursor']])
  ok('#' + id + ' 绑定到 ' + fn, new RegExp("\\$\\('" + id + "'\\)[\\s\\S]{0,220}" + fn).test(netInitBlock));
ok('表情行按钮按 data-em 绑定到 doEmote', /querySelectorAll\('\[data-em\]'\)[\s\S]{0,120}doEmote\(b\.dataset\.em\)/.test(netInitBlock));
ok('标点可通过 G 键发出', /KeyG[\s\S]{0,90}sendPing\(/.test(src));
ok('数字键 1~4 触发表情', /Digit1: 'wave'/.test(src) && /emap\[e\.code\][\s\S]{0,60}doEmote\(/.test(src));
for (const cb of ['onPeerEmote', 'onPeerPvp', 'onPlayerHit', 'onPeerHit', 'onPing'])
  ok('net.init 注册了 ' + cb, netInitBlock.includes(cb + ':'));
ok('受到的切磋伤害走本地受伤', /onPlayerHit[\s\S]{0,80}hurtPlayer\(/.test(netInitBlock));
ok('hurtPlayer 传递伤害来源名', /function hurtPlayer\(dmg, from, by\)/.test(src) && /killPlayer\(by\)/.test(src));
ok('切磋只在双方开启时结算', /if \(pvpOn && net\.state === 'online'\)/.test(src) && /if \(!r\.pvp\) continue/.test(src));
ok('攻击命中远端玩家时上报服务端', /net\.hit\(r\.id,/.test(src));
ok('标点每帧更新（漂浮/淡出/过期）', /update\(dt\)[\s\S]{0,700}updatePings\(dt\)/.test(src));
ok('标点画进小地图', /drawPingsOnMap\(c, S, m, sc, inR\)/.test(src));
ok('小地图可点击发出标点', /const cv = \$\('minimap'\)/.test(src) && /cv\.addEventListener\('click'/.test(src) && /initMapPing\(\)/.test(netInitBlock));
ok('指针锁定下小地图点击不生效（避免误标）', /G\.state !== 'play' \|\| G\.locked/.test(src));
ok('表情/标点使用独立气泡与标记，销毁不遗漏', /myBubble\.material\.map\.dispose/.test(src) && /old\.mesh\.material\.map\.dispose/.test(src));
ok('net.js 屏蔽自己的切磋开关回声', /if \(d\.p === this\.pid\) break/.test(readFileSync(ROOT + 'src/net.js', 'utf8')));
ok('触摸端隐藏光标模式按钮', /isTouch[\s\S]{0,60}\$\('modeBtn'\)\.style\.display = 'none'/.test(src));
const ids = [...new Set([...src.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
const missing = ids.filter((i) => !tpl.includes('id="' + i + '"'));
ok('main.js 引用的 ' + ids.length + ' 个界面 id 全部存在', missing.length === 0, 'missing: ' + missing.join(','));
ok('界面排布按 netbar 实测高度而非硬编码', /nbB = Math\.round\(nb\.getBoundingClientRect\(\)\.bottom\)/.test(src) && !/nbTop \+ 30/.test(src));

console.log(R.join('\n'));
const failed = R.filter((x) => x.startsWith('FAIL')).length;
console.log(failed ? `WIRING FAIL (${failed}/${R.length})` : `WIRING PASS (${R.length} 项)`);
process.exit(failed ? 1 : 0);
