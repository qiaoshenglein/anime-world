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
for (const id of ['acct', 'acctBtn', 'acctClose', 'acctLine', 'acctStats', 'acctName', 'acctPass', 'bindBtn', 'loginBtn', 'logoutBtn'])
  ok('模板含 #' + id, tpl.includes('id="' + id + '"'));
for (const id of ['joinBtn', 'nameIn', 'srvIn', 'nstat', 'nonline', 'mpBox', 'mpHint', 'chatIn', 'chSend', 'netbar', 'leaveBtn', 'chToggle', 'chat',
  'acct', 'acctBtn', 'acctClose', 'acctLine', 'acctStats', 'acctName', 'acctPass', 'bindBtn', 'loginBtn', 'logoutBtn'])
  ok('main.js 引用 #' + id, src.includes("$('" + id + "')"));
// 面板里的每个输入都得挡下按键：否则打字会同时触发游戏快捷键
ok('档案输入不泄漏成游戏快捷键', /for \(const id of \['acctName', 'acctPass'\]\)[\s\S]{0,240}e\.stopPropagation\(\)/.test(src));
ok('P 键开关档案、Esc 关闭', /KeyP'\) acctToggle\(\)/.test(src) && /Escape' && acctShown\) acctToggle\(false\)/.test(src));
ok('掉线或离开游戏时档案面板一起收起', /if \(!playing \|\| !active\) acctToggle\(false\)/.test(src));
ok('绑定/登录/退出各自接上处理器', /\$\('bindBtn'\)\.addEventListener\('click', acctBind\)/.test(src)
  && /\$\('loginBtn'\)\.addEventListener\('click', acctLogin\)/.test(src)
  && /\$\('logoutBtn'\)\.addEventListener\('click', acctLogout\)/.test(src));
ok('面板文案不写死：昵称与绑定状态来自服务端', /net\.me[\s\S]{0,40}bound/.test(src) && /m\.bound \? '已绑定/.test(src));
ok('登录失败只说结论不透细节', /j\.err === 'bad' \? '昵称或密码不对'/.test(src));

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
// ---- 旅伴面板：找不到人 / 追不上人
for (const id of ['pals', 'palList', 'nlane']) ok('模板含 #' + id, tpl.includes('id="' + id + '"'));
ok('#palList 点击绑定 palClick', /\$\('palList'\)\.addEventListener\('click', palClick\)/.test(netInitBlock));
ok('面板每帧刷新（节流由内部 5Hz 控制）', /update\(dt\)[\s\S]{0,800}updatePals\(dt\)/.test(src));
ok('方位与小地图同一基准', /function palBearing[\s\S]{0,240}camBasis\(\)/.test(src));
ok('锁定目标后小地图画指向线', /const pr = palTarget\(\);[\s\S]{0,700}setLineDash/.test(src));
ok('追上旅伴自动解除锁定', /palLock = null; palKey = '';[\s\S]{0,120}追上/.test(src));
ok('旅伴离开时清掉悬空锁定', /onPeerLeave: \(name, id\)[\s\S]{0,140}id === palLock/.test(netInitBlock));
ok('面板显隐会重排左列', /if \(on !== palShown\)[\s\S]{0,140}layoutTouchHud\(\)/.test(src));
ok('表情行与旅伴面板按实测高度堆叠', /shown\(er\)[\s\S]{0,200}shown\(pl\)/.test(src));
ok('在线人数随名单变化即时刷新', /if \(netCount !== net\.remotes\.size \+ 1\) mpSync\(\)/.test(src));
ok('netbar 显示当前分线', /\$\('nlane'\)\.textContent[\s\S]{0,80}net\.lane/.test(netInitBlock));
const netjs = readFileSync(ROOT + 'src/net.js', 'utf8');
ok('客户端读取 ?lane= 深链', /URLSearchParams\(location\.search\)\.get\('lane'\)/.test(netjs));
ok('join 使用请求分线而非硬编码', /l: this\.wantLane/.test(netjs) && !/l: 0,/.test(netjs));
ok('以服务端实际落位为准（满了会被挪线）', /case 'welcome'[\s\S]{0,120}this\.lane = d\.lane/.test(netjs));
// ---- 留言石碑
ok('模板含 #bdBtn', tpl.includes('id="bdBtn"'));
ok('#bdBtn 绑定到刻留言', /\$\('bdBtn'\)[\s\S]{0,120}startBoardWrite\(\)/.test(netInitBlock));
ok('V 键也能刻留言', /KeyV[\s\S]{0,60}startBoardWrite\(\)/.test(src));
ok('E 在无人可谈时读到石碑', /boardInteract\(\);/.test(src.slice(src.indexOf('function interact()'), src.indexOf('function interact()') + 640)));
ok('石碑每帧同步（10Hz 节流）', /update\(dt\)[\s\S]{0,900}updateBoards\(dt\)/.test(src));
ok('靠近才浮出留言文字', /d < BOARD_SEE/.test(src) && /material\.opacity = clamp\(\(BOARD_SEE - d\)/.test(src));
ok('离开视野或文本变化时销毁气泡贴图', /if \(m\.text !== label\)[\s\S]{0,120}killPlaque\(m\)/.test(src) && /else killPlaque\(m\)/.test(src));
ok('石碑网格随 net.boards 回收', /for \(const \[id, m\] of boardMeshes\) if \(!net\.boards\.has\(id\)\)/.test(src));
ok('HUD 提示改写与点心的区分', /改写 · 你的留言[\s\S]{0,60}点心 · /.test(src));
ok('输入框兼作刻留言（Enter/Esc 都有出口）', /if \(boardMode\)\{ ?closeInput\(\); ?submitBoard\(v\); ?return; ?\}|if \(boardMode\) \{ closeInput\(\); submitBoard\(v\); return; \}/.test(src) && /e\.key === 'Escape'\) closeInput\(\)/.test(src));
ok('服务端静默拒绝时给出本地提示', /if \(net\.myBoard\(\)\?\.s === text\) markFeat\('feat_words'\)/.test(src));
ok('net.js 用 welcome 快照重置留言', /case 'welcome'[\s\S]{0,300}this\.boards\.clear\(\)/.test(netjs));
ok('net.js 幂等 upsert 自己的回灌', /case 'mb':[\s\S]{0,160}this\.boards\.set\(d\.p/.test(netjs));

// 广播对象里 `t` 是消息类型：把带 t 字段的实体展开在后面会把它覆盖掉（曾经整条留言因此收不到）
const srv = readFileSync(ROOT + 'server/index.js', 'utf8');
ok('服务端广播不用展开运算符覆盖消息类型', !/\{\s*t:\s*'[a-z]+',[^}]*\.\.\.[a-zA-Z]/.test(srv), (srv.match(/\{\s*t:\s*'[a-z]+',[^}]*\.\.\.[a-zA-Z]/) || [''])[0]);
ok('石碑广播统一走 boardBcast（显式列字段，带静音用的 u/own）',
  /const boardBcast = \(row, u, own\) => \(\{ t: 'mb', u, own, p: row\.account/.test(srv) &&
  /broadcastAll\([^\n]*boardBcast\(store\.board\(mine\), p\.acct \|\| '', mine\)\)/.test(srv) &&
  /broadcastAll\([^\n]*boardBcast\(store\.board\(owner\), p\.acct \|\| '', owner\)\)/.test(srv));

ok('界面排布按 netbar 实测高度而非硬编码', /nbB = Math\.round\(nb\.getBoundingClientRect\(\)\.bottom\)/.test(src) && !/nbTop \+ 30/.test(src));

// ---- 账号与权威进度（联网层 + 游戏侧接线）

ok('连线前先取回身份（游客号也要握手时就带上 cookie）', /\(net\.acct \? Promise\.resolve\(\) : net\.whoAmI\(\)\)\.then\(\(\) => net\.connect/.test(src));
ok('页面一开就悄悄开好游客号', /net\.whoAmI\(\)\.then\(\(j\) =>/.test(src));
ok('屏蔽名单跟着账号回来（按钮状态不骗人）', /for \(const u of \(j && j\.mutes\) \|\| \[\]\) myMutes\.add\(u\)/.test(src));
ok('账号接口只走同源 cookie（凭据前端读不到）', /credentials: 'same-origin'/.test(netjs) && !/localStorage[\s\S]{0,40}sid/.test(netjs));
ok('换身份后重连（登录/退出都要重新握手）', /async logIn\(n, p\)[\s\S]{0,240}this\.reconnect\(\)/.test(netjs) && /async logOut\(\)[\s\S]{0,200}this\.reconnect\(\)/.test(netjs));
ok('后端不可用时静默当匿名玩家（file:// 也能玩）', /catch \{ return \{ status: 0, j: null \}/.test(netjs));
ok('welcome 落到联网层：进度/战绩/碎片全量', /case 'welcome'[\s\S]{0,600}this\.prog = d\.prog[\s\S]{0,200}this\.record = d\.pvp[\s\S]{0,200}this\.taken = new Set/.test(netjs));
ok('welcome 交给游戏侧灌入本地状态', /onWelcome: \(d\) => applyWelcome\(d\)/.test(src));
ok('重连后接上旧旅程（碎片与击败不清零）', /function applyWelcome[\s\S]{0,300}P\.collected = Math\.max\(P\.collected, pr\.shards/.test(src));
ok('已被采走的碎片不再出现在脚下', /for \(const s of world\.shards\) if \(!s\.taken && net\.shardTaken\(s\.x, s\.z\)\) s\.taken = true/.test(src));
ok('拾取上报服务端去重', /net\.take\(s\.x, s\.z\)/.test(src));
ok('他人采走碎片时本地同步消失', /onShardTaken: \(s\) => shardGone\(s\)/.test(src));
ok('任务阶段推进要经服务端认可', /if \(net\.world && net\.world\.stage < s\) net\.quest\(\{ st: s \}\)/.test(src));
ok('世界快照回来时更新阶段与界面', /onWorld: \(w\) => applyWorldMsg\(w\)/.test(src) && /function applyWorldMsg[\s\S]{0,700}syncKing\(\)/.test(src));
// 王属于整条分线：本地不得自行打死，血量与生死都跟服务端
ok('联机时本地不能自行击杀史莱姆王', /enemyCtx\.holdKill = \(e\) => e\.king && net\.state === 'online' && !!net\.world && net\.world\.kingAlive/.test(src));
ok('每帧用权威血量盖回本地血量', /function updateEnemies\(dt\) \{\n  syncKing\(\)/.test(src));
ok('每一跳王伤害都上报', /if \(e\.king\) net\.kingHit\(dmg\)/.test(src) && /if \(e\.king\) net\.kingHit\(3 \+ P\.dmgBonus\)/.test(src));
ok('服务端复活与本地复活不冲突（不刷出第二只）', /if \(!enemies\.some\(\(e\) => e\.king && !e\.dead\)\) spawnSlime\(POI\.ruins/.test(src));
ok('倒下次数记在个人档案', /function respawnPlayer\(\)[\s\S]{0,400}net\.died\(\)/.test(src) && /died\(\) \{ if \(this\.state === 'online'\) this\._send\(\{ t: 'qs', de: 1 \}\)/.test(netjs));
ok('愿望计数上报（同线可见几人许过愿）', /net\.quest\(\{ st: 5, wi: \(net\.world \? net\.world\.wish \+ 1 : 1\) \}\)/.test(src));
ok('强化武器也要落到服务端', /Q\.upgraded = true; applyGrowth\(\); net\.quest\(\{ up: 1 \}\)/.test(src));
// 静音/举报：入口在旅伴名单里，且没有身份的对象不给按钮
ok('旅伴名单给有身份的同伴屏蔽/举报入口', /dataset\.act = 'mute'/.test(src) && /dataset\.act = 'report'/.test(src));
ok('匿名旅伴没有可追责的身份（不给入口）', /if \(r\.acct && net\.me\?\.a\)/.test(src));
ok('点名单行为按钮不误触发锁定', /if \(act === 'mute'\) palMute\(r\); else palReport\(r\);\n    return;/.test(src));
ok('举报借用聊天输入框（有入口也有出口）', /if \(reportMode\) \{ closeInput\(\); submitReport\(v\); return; \}/.test(src) && /closeInput = \(\) => \{ boardMode = false; reportMode = false/.test(src));
ok('联网层屏蔽/举报只在有身份时发', /mute\(acct, on = true\) \{\n    if \(this\.state === 'online' && this\.me\?\.a/.test(netjs) && /report\(acct, why\) \{\n    if \(this\.state === 'online' && acct\)/.test(netjs));
ok('留言石碑按账号存也有匿名兜底', /boardKey\(\) \{ return this\.me\?\.a \|\| this\.pid; \}/.test(netjs));
ok('远端旅伴带上账号（静音/举报按人不按连接）', /new Remote\(api, p\.p, p\.n, p\.x, p\.y, p\.z, p\.Y, p\.look, p\.pv, p\.u\)/.test(netjs));
// ---- 舒适与画质设置（晕动症是硬约束，开关必须真的接进表现层）
for (const id of ['set', 'setBtn', 'setBarBtn', 'setClose', 'setRows', 'setPresets', 'setLead'])
  ok('模板含 #' + id, tpl.includes('id="' + id + '"'));
ok('设置面板在标题页之上可达（.ovl 层级高于 #title 的 50）', /\.ovl\{[^}]*z-index:60/.test(tpl) && /#loading,#title,#ending\{[^}]*z-index:50/.test(tpl));
ok('镜头震动被设置缩放', /const amp = G\.shakeAmt \* SET\.shake/.test(src));
ok('震动归零时连随机抖动都不算', /G\.shakeAmt > 0\.001 && SET\.shake > 0\.01/.test(src));
ok('冲刺/滑翔的视野拉开幅度可关', /SET\.fov \+ SET\.kick \*/.test(src));
ok('鼠标灵敏度与边缘转向速率都走设置', /0\.0024 \* SET\.look/.test(src) && /\* 1\.35 \* SET\.steer/.test(src));
ok('花瓣与萤火虫密度可调', /SET\.petals\b/.test(src) && /SET\.fire\b/.test(src));
ok('渲染精度改动会重设像素比', /renderer\.setPixelRatio\(pxr\(\)\)/.test(src) && /composer\.setPixelRatio\(pxr\(\)\)/.test(src));
ok('阴影开关动的是光源而非 shadowMap（不需材质重编译）', /dayNight\.sun\.castShadow = SET\.shadow > 0\.5/.test(src));
ok('泛光同时听快捷键与设置', /G\.bloomOn && SET\.bloom > 0\.5/.test(src));
ok('音量走 audio.setVol', /audio\.setVol\(SET\.vol\)/.test(src) && /setVol\(v\) \{/.test(readFileSync(ROOT + 'src/audio.js', 'utf8')));
ok('设置持久化且只认数字（脏数据不能拦住启动）', /localStorage\.setItem\('aw\.settings'/ .test(src) && /typeof j\[k\] === 'number' && isFinite\(j\[k\]\)/.test(src));
ok('滑杆输入不泄漏成游戏快捷键', /inp\.addEventListener\('keydown', \(e\) => e\.stopPropagation\(\)\); \/\/ 调滑杆不该触发游戏快捷键/.test(src));
ok('「容易晕」预设真的把震动归零', /sick: \{ shake: 0,/.test(src));
ok('设置面板有开有关（Esc 与 ✕ 都能收）', /KeyO'\) setToggle\(\)/.test(src) && /Escape' && setShown\) setToggle\(false\)/.test(src) && /\$\('setClose'\)\.addEventListener\('click', \(\) => setToggle\(false\)\)/.test(src));
// 顺序陷阱：settingsInit 里 applySet 会碰 dayNight/bloom/audio，必须在世界与渲染器起来之后调用
const bootAt = src.indexOf("$('title').classList.remove('hidden')");
ok('settingsInit 在标题页出现之后才调用', /settingsInit\(\)/.test(src.slice(bootAt, bootAt + 400)), 'boot 顺序');
ok('标题页有直达按钮，不必先进世界', /\$\('setBtn'\)\.addEventListener\('click', \(\) => \{ audio\.start\(\); setToggle\(\); \}\)/.test(src));
ok('面板战绩同步到服务端档案（pr 只回本人）', /case 'pr':[\s\S]{0,120}this\.prog = d\.prog[\s\S]{0,60}api\.onProg/.test(netjs) && /onProg: \(p\) => \{ syncGrowthFromServer\(p, claimQuiet\); claimQuiet = false; renderAcct\(\); \}/.test(src));
ok('面板随时打开都不显示旧数字', /function applyWorldMsg[\s\S]{0,600}\n  renderAcct\(\);/.test(src));

// ---- 旅人之书：星尘成长 / 景点图鉴 / 衣橱
for (const id of ['book', 'bookClose', 'bookTabs', 'bookGem', 'bookBody', 'bookHint', 'bookBtn', 'bookTitleBtn'])
  ok('模板含 #' + id, tpl.includes('id="' + id + '"'));
for (const t of ['gear', 'stamps', 'wardrobe']) ok('图鉴有 ' + t + ' 页签', tpl.includes('data-tab="' + t + '"'));
ok('net.js 引用 #book', src.includes("$('book')"));
// 成长定义只写一处：价格由服务端下发，前端那份只是单机兜底
ok('成长线定义前后端同源', /const gearSpec = \(\) => net\.gearSpec \|\| GEAR_DEF/.test(src) && /this\.gearSpec = d\.gear \|\| null/.test(netjs));
ok('服务端下发 gear 定义', /gear: GEAR, gemCost: GEAR_KILL_GEM/.test(srv));
for (const [k, name] of [['vit', '体魄'], ['jump', '弹跳'], ['glide', '滑翔'], ['dmg', '剑伤'], ['shot', '星射']])
  ok('成长线 #' + k + '（' + name + '）在客户端与服务端都齐全',
    src.includes(k + ": { name: '" + name + "'") && srv.includes(k + ": { name: '" + name + "'"));
// 手感的唯一出口
ok('跳跃参数取自成长（不写死二段跳）', /P\.vy = P\.jumpV;/.test(src) && /else if \(P\.jumps < P\.maxJumps\)/.test(src));
ok('滑翔耗体力取自成长（也要乘上这条线的天）', /P\.stamina -= P\.glideDrain \* WX_GLIDE_MUL\[playWeather\(\)\] \* dt;/.test(src));
ok('伤害加成只从 applyGrowth 出来', !/P\.dmgBonus = 1;/.test(src) && /P\.dmgBonus = g\.dmg \+ \(Q\.upgraded \? 1 : 0\)/.test(src));
ok('升级即刻反映到身上', /saveGrowth\(\); applyGrowth\(\); levelUpGlow/.test(src));
// 两条记账路径：有身份时世界说了算，单机时设备说了算
ok('消费由服务端裁决（本地只发意愿）', /if \(serverGrowth\(\)\) \{ spendWait = \{ k, lv \}; net\.spend\(k\); \}/.test(src));
ok('被拒绝的升级有本地提示', /if \(GR\.gear\[spendWait\.k\] === spendWait\.lv\)/.test(src));
ok('单机采碎片才在本地加星尘（按天气表给）', /if \(!serverGrowth\(\)\) gainGem\(sg\)/.test(src) && /const sg = WX_SHARD_GEM\[playWeather\(\)\]/.test(src));
ok('welcome 全量对齐不刷屏', /if \(serverGrowth\(\)\) syncGrowthFromServer\(pr, true\)/.test(src) && /\n  maybeClaimLedger\(\);/.test(src));
ok('设备旧账只在世界空白时认领', /if \(\(pr\.gem \| 0\) !== 0 \|\| Object\.keys\(pr\.gear \|\| \{\}\)\.length\) \{ growthMigrated = true/.test(src));
ok('认领时先静默再发送（不为旧等级跳舞）', /claimQuiet = true;\s*\n\s*net\.claimGrowth\(devLedger\.gem, devLedger\.gear, COD\)/.test(src));
// 图鉴：键要能被服务端认下
const KEY_RE = /^[a-z][a-z0-9_]{1,23}$/;
const placeKeys = (src.match(/const PLACE_KEYS = \[([^\]]*)\]/) || ['', ''])[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
const featKeys = (src.match(/const FEATS = \[([\s\S]*?)\n\];/) || ['', ''])[1].match(/'(feat_\w+)'/g) || [];
ok('景点键全部合法（' + placeKeys.length + ' 处）', placeKeys.length >= 10 && placeKeys.every((k) => KEY_RE.test(k)), placeKeys.join(','));
ok('成就键全部合法（' + featKeys.length + ' 条）', featKeys.length >= 4 && featKeys.every((k) => KEY_RE.test(k.replace(/'/g, ''))), featKeys.join(','));
ok('图鉴按位置自动翻页（0.4s 节流）', /updateStamps\(dt\)[\s\S]{0,160}stampT = 0\.4/.test(src) && /updateBoards\(dt\);\s*\n\s*updateStamps\(dt\);/.test(src));
ok('同一页不重复记（本地先去重）', /function markCodex\(key, name\) \{\s*\n\s*if \(hasStamp\(key\)\) return;/.test(src));
ok('王的成就只算亲眼看着倒下的那次', /if \(prevKingAlive === true && !w\.kingAlive\) markFeat\('feat_king'\)/.test(src));
ok('集齐所有位置才给旅行家', /if \(PLACE_KEYS\.every\(\(k\) => hasStamp\(k\)\)\) markFeat\('feat_traveller'\)/.test(src));
// 衣橱
ok('换装立即重建角色并广播', /saveLookLocal\(\);\s*\n\s*rebuildChar\(\);\s*\n\s*net\.setLook\(LK\)/.test(src));
ok('饰品按图鉴页数解锁', /if \(stampCount\(\) < need\)/.test(src) && /const W_ACC = \[\['hat'/.test(src));
ok('最多戴两件套饰', /else if \(LK\.acc\.length >= 2\)/.test(src));
ok('服务端也限定饰品白名单与数量', /out\.acc = o\.acc\.filter\(\(x\) => typeof x === 'string' && LOOK_ACC\.includes\(x\)\)\.slice\(0, 2\)/.test(readFileSync(ROOT + 'server/index.js', 'utf8')));
ok('外观跟着账号走（不是跟着设备）', /p\.look = \(p\.acct && store\.acct\(p\.acct\)\?\.look\) \|\| cleanLook\(d\.p\.look\)/.test(readFileSync(ROOT + 'server/index.js', 'utf8')));
ok('welcome 带回外观，客户端照穿', /look: p\.look \|\| null/.test(readFileSync(ROOT + 'server/index.js', 'utf8')) && /if \(d\.look\) adoptLook\(d\.look\)/.test(src));
ok('N 键开图鉴、Esc 关闭', /KeyN'\) bookToggle\(\)/.test(src) && /Escape' && bookShown\) bookToggle\(false\)/.test(src));
ok('标题页就能翻书', /\$\('bookTitleBtn'\)\.addEventListener\('click', \(\) => \{ audio\.start\(\); bookToggle\(\); \}\)/.test(src));
ok('匿名时外观按名字发色（不会撞衫）', /initLook\(nameIn\.value\)/.test(src) && /export function defaultLook\(seed\)/.test(netjs));
ok('远端换装重建网格并释放旧材质', /relook\(api, look\)[\s\S]{0,300}this\.char\.mats\?\.forEach\?\.\(\(m\) => m\.dispose\(\)\)/.test(netjs) && /case 'lk'[\s\S]{0,120}r\.relook\(api, d\.look\)/.test(netjs));

// ---- 世界生机：分线天气 / 烟花 / 白鹿与夜光菌 / 新表情
ok('模板小地图上写着天气', tpl.includes('id="wx"'));
ok('天气显示跟着分线走', /\$\('wx'\)\.textContent = WEATHER_NAME\[weatherCode\(\)\]/.test(src));
ok('天气由服务端下发、客户端只能读', /weather: w\.we \| 0/.test(netjs) && /net\.world \? clamp\(net\.world\.weather \| 0/.test(src));
ok('服务端没有「客户端设天气」的入口', !/case 'we'|case 'wx'|handleWeather/.test(srv) && /weather: WEATHER_PIN >= 0 \? WEATHER_PIN : \(WEATHER\[r\.weather \| 0\]/.test(srv));
ok('换天是慢慢过渡的（不是啪一下变）', /const k = 1 - Math\.exp\(-dt \* 0\.5\)/.test(src) && /for \(const key of WX_KEYS\) WX\[key\] \+= \(t\[key\] - WX\[key\]\) \* k/.test(src));
ok('关掉天气开关就永远是晴空', /SET\.weather > 0\.5 \?/.test(src));
ok('空分线不替人记天气', /if \(lm && lm\.size\) \{\s*\n\s*let n = w\.weather;/.test(srv));
ok('雨与流星各有一个实例层', /rain = new Rain\(scene\)/.test(src) && /meteors = new Meteors\(scene\)/.test(src) && /export class Rain/.test(readFileSync(ROOT + 'src/particles.js', 'utf8')));
ok('雨与流星都跟着天气强度走', /rain\.update\(dt, G\.t, camera\.position, wwind, WX\.rain\)/.test(src) && /meteors\.update\(dt, G\.t, camera\.position, WX\.meteor \* \(0\.25 \+ dayNight\.night\)\)/.test(src));
ok('雾的距离由天气推着改', /if \(scene\.fog\) scene\.fog\.far = WX\.fog/.test(src));
ok('F 键放烟花并且连线时通知同伴', /KeyF'\) throwFirework\(\)/.test(src) && /net\.firework\(P\.pos\.x, P\.pos\.z\)/.test(src) && /case 'fw': if \(p\.joined\) handleFirework\(p, d\)/.test(srv));
ok('触屏玩家也有烟花按钮（netbar 胶囊 + 本地冷却）', tpl.includes('id="fwBtn"') && /\$\('fwBtn'\)\.addEventListener\('click', \(\) => \{ audio\.start\(\); throwFirework\(\); \}\)/.test(src) && /G\.t - myFwT < 2\.5/.test(src));
ok('烟花八秒才允许一朵', /if \(t - \(p\.lastFw \|\| 0\) < 8000\)/.test(srv));
ok('收到的烟花会真的响', /onFirework: \(f\) => \{ launchFirework\(f\.x, f\.z\)/.test(src));
ok('值得庆祝的事会给这条分线放一场', /if \(FEAT_KEYS\.includes\(key\)\) celebrate/.test(src));
ok('白鹿与夜光菌都真的存在', /function spawnLife\(\)/.test(src) && /spawnNPCs\(\);\s*\n\s*spawnLife\(\)/.test(src) && /of \[\[POI\.forest, 2\], \[POI\.meadow, 2\]\]/.test(src));
ok('夜里菌子才亮起来', /shrooms\.mat\.opacity = 0\.1 \+ on \* 0\.85/.test(src));
ok('白鹿靠近会走开（躲多远由这条线的天决定）', /d\.flee = dist < fleeR \? 2\.4/.test(src) && /const fleeR = WX_DEER_FLEE\[pw\]/.test(src));
ok('服务端表情白名单收到六个动作', /const EMOTES = \['wave', 'heart', 'up', 'spark', 'bow', 'dance'\]/.test(srv) && /EMOTES = \{[^}]*bow:[^}]*dance/.test(netjs));
ok('鞠躬与起舞真的动起身', /if \(GESTURE_DUR\[kind\]\) P\.gest = \{ k: kind, t: 0 \}/.test(src) && /gesture: P\.gest && !P\.swim && !P\.glide/.test(src) && /s\.gesture === 'bow'/.test(readFileSync(ROOT + 'src/character.js', 'utf8')));
ok('动作时长两头共用一份', /export const GESTURE_DUR = \{ bow: 1\.5, dance: 2\.6 \}/.test(netjs) && /GESTURE_DUR\[P\.gest\.k\]/.test(src));
ok('模板上六个动作都有按钮', ['wave', 'heart', 'up', 'spark', 'bow', 'dance'].every((e) => tpl.includes('data-em="' + e + '"')));

// ---- 星屑弹：远程攻击（蓄力 / 索敌 / 穿透），手感上不许动镜头
const audiojs = readFileSync(ROOT + 'src/audio.js', 'utf8');
ok('模板有蓄力条与触屏星弹按钮', tpl.includes('id="charge"') && tpl.includes('id="chargefill"') && tpl.includes('id="tbShot"'));
ok('帮助与标题页都写清了 R 键', /长按 R<\/b> 星屑弹/.test(tpl) && /<b>长按 R<\/b><span>星屑弹/.test(tpl));
ok('蓄力是「按住」的：键盘与触屏共用一个开关', /keys\.KeyR \|\| touch\.shot/.test(src) && /btn\('tbShot', \(\) => \{ touch\.shot = true; \}, \(\) => \{ touch\.shot = false; \}\)/.test(src));
ok('松手才放出去，收势不记账', /else if \(P\.shot\) releaseCharge\(\)/.test(src) && /\} else if \(P\.shot\) cancelCharge\(\);/.test(src));
ok('体力是这一发的货币，没力气蓄不起也放不出', /const cost = Math\.min\(6 \+ 6 \* c, P\.stamina\)/.test(src) && /P\.stamina < 8/.test(src) && /if \(cost < 3\) \{ audio\.play\('blip'\); return; \}/.test(src));
ok('出手之间留有冷却', /shotCdT = G\.t \+ SHOT_CD/.test(src) && /G\.t < shotCdT/.test(src));
ok('索敌只认视线前方，不会把人硬拽转身', /if \(dot < 0\.55\) continue;/.test(src) && /const s = d \* \(1\.7 - dot\)/.test(src));
ok('弹道仍是看得见的直线，只是被软软地掰向目标', /const k = 1 - Math\.exp\(-dt \* 3\.4\)/.test(src));
ok('满蓄才穿人，能穿几个取自星射等级', /maxHits: full \? SHOT_HITS\[GR\.gear\.shot\] : 1/.test(src) && /const SHOT_SPEED = 30, SHOT_CD = 0\.32, SHOT_HITS = \[1, 1, 2, 3\]/.test(src));
ok('远程打王照样封顶在服务端', /if \(e\.king\) net\.kingHit\(b\.dmg\)/.test(src));
ok('同伴那一发只演出不结算', /if \(!gone && !b\.peer\)/.test(src) && /onPeerBolt: \(b\) => \{ if \(G\.state === 'play'\) peerBolt\(b\); \}/.test(src) && /maxHits: 0, peer: true/.test(src));
ok('客户端只报朝向与蓄力度，坐标由服务端补', /bolt\(c, Y\) \{[\s\S]{0,160}\{ t: 'bo', c:/.test(netjs) && !/\{ t: 'bo'[\s\S]{0,80}x:/.test(netjs));
ok('服务端转发演出、限流，且一个伤害字段也不带', /case 'bo': if \(p\.joined\) handleBolt\(p, d\)/.test(srv) && /\{ t: 'bo', p: p\.id, c: \+num\(d\.c, 0, 1\)\.toFixed\(2\), Y: \+num\(d\.Y, -7, 7\)\.toFixed\(3\) \}/.test(srv) && /if \(t - \(p\.lastBo \|\| 0\) < 350\)/.test(srv) && !/function handleBolt[\s\S]{0,420}(dmg|kingHit|kingHp)/.test(srv));
ok('星屑弹全程不碰镜头（容易晕的人的硬约束）', !/shake\(/.test(src.slice(src.indexOf('function boltMesh'), src.indexOf('enemyCtx.scene'))));
ok('蓄力时脚步放慢、身体跟着镜头转', /if \(P\.shot\) spd \*= 0\.62/.test(src) && /P\.yaw = lerpAngle\(P\.yaw, Math\.atan2\(b0\.fx, b0\.fz\)/.test(src));
ok('蓄力中不能挥剑，也不会边走边改瞄准', /if \(P\.atk \|\| P\.cast \|\| P\.shot \|\| P\.dead/.test(src) && /moving && !P\.atk && !P\.cast && !P\.shot && P\.hurtT <= 0/.test(src));
ok('受伤即断蓄力', /P\.atk = null;\s*\n\s*cancelCharge\(\);/.test(src));
ok('弹的数值也只从 applyGrowth 出来', /P\.shotDmg = 2 \+ g\.shot/.test(src) && /P\.chargeT = 0\.85 - 0\.09 \* g\.shot/.test(src));
ok('服务端回灌的等级按定义逐条夹住（不再点名写死）', /for \(const k of GEAR_KEYS\) next\[k\] = clamp\(gear\[k\] \| 0, 0, \(spec\[k\] \|\| GEAR_DEF\[k\]\)\.max\)/.test(src));
ok('出手有三种声音，远处的第四种', /case 'charge':/.test(audiojs) && /case 'shot':/.test(audiojs) && /case 'shotFull':/.test(audiojs) && /case 'shotFar':/.test(audiojs));
ok('弹体用共享几何，不打进场景就回收', /shots\.splice\(i, 1\)/.test(src) && /scene\.remove\(b\.m\)/.test(src) && !/boltMat\.dispose/.test(src));

// ---- 史莱姆潮：整条分线共用的 PVE 协作事件
const enjs = readFileSync(ROOT + 'src/enemies.js', 'utf8');
const dbjs = readFileSync(ROOT + 'server/db.js', 'utf8');
ok('模板挂着潮水的池子条', tpl.includes('id="tide"') && tpl.includes('id="tidefill"') && tpl.includes('id="tidetxt"'));
ok('池子条只在这条分线开潮时出现', /const tw = net\.world, showTide = tideOn\(\)/.test(src) && /\$\('tide'\)\.classList\.toggle\('hidden', !showTide\)/.test(src));
ok('潮水按波次补足，不是一次性刷一堆', /for \(let i = n; i < TIDE_ALIVE; i\+\+\) spawnTideSlime\(\)/.test(src) && /syncKing\(\);\s*\n\s*syncTide\(\)/.test(src));
ok('波退了把散兵变回普通史莱姆（不再往池子里记）', /if \(tideWas\) \{ tideWas = false; for \(const e of enemies\) if \(e\.tide && !e\.dead\) e\.tide = false; \}/.test(src));
ok('挥剑、爆发、星屑弹都把伤害投进池子', (src.match(/else tideReport\(/g) || []).length === 3);
ok('投池只认联机且真的有潮', /if \(!e\.tide \|\| !tideOn\(\)\) return;\s*\n\s*net\.tideHit\(dmg\)/.test(src));
ok('客户端报不出池子的结论（只报一跳，封顶由服务端夹）', /tideHit\(dmg\) \{[\s\S]{0,120}\{ t: 'th', d: Math\.max\(1, Math\.round\(dmg\)\)/.test(netjs) && /w\.tideHp = Math\.max\(0, w\.tideHp - Math\.round\(num\(d\.d, 1, cfg\.tideHit\)\)/.test(srv));
ok('两个人在场才开潮', /if \(!w\.tideAlive && alone >= 2 && t >= \(w\.tideNextAt \|\| 0\)\) openTide/.test(srv));
ok('池子按人头加，下一波要等间隔', /w\.tideMax = cfg\.tideHp \+ Math\.max\(0, n - 2\) \* Math\.round\(cfg\.tideHp \* 0\.6\)/.test(srv) && /w\.tideNextAt = t \+ cfg\.tideMs/.test(srv));
ok('压下一波给全线有身份的人都记星尘', /q\.prog\.gem = \(q\.prog\.gem \| 0\) \+ cfg\.tideGem/.test(srv));
ok('完成广播只带波次与奖励，放烟花是客户端的事', /broadcastAll\(lm, \{ t: 'td', r: w\.tideRound, g: cfg\.tideGem \}\)/.test(srv) && /onTideDone: \(e\) => \{/.test(src) && /markFeat\('feat_tide'\)/.test(src));
ok('潮水退去写进入图鉴的一页', /\['feat_tide', '潮水退去'/.test(src));
ok('潮水史莱姆有自己的颜色与更近的扑人距离', /tide: 0x4fd8c4/.test(enjs) && /this\.tide \? 17 : 11/.test(enjs));
ok('潮水死了不排常规刷新（由波次补足）', /\} else if \(!e\.tide\) respawns\.push\(\{ t: 40 \+ Math\.random\(\) \* 20 \}\)/.test(src));
ok('开潮的提示只在真的「由无到有」时给', /if \(prevTideAlive === false && w\.tideAlive && G\.state === 'play' && !G\.cine\)/.test(src) && /prevTideAlive = w \? w\.tideAlive : null/.test(src));
ok('潮也不动镜头（只在池子条与烟花上给反馈）', !/shake\(/.test(src.slice(src.indexOf('const TIDE_ALIVE = 5'), src.indexOf('function updateEnemies'))));
ok('潮的四个阈值都能用环境变量调', /tideMs: Number\(env\.TIDE_MS \|\| 150000\)/.test(srv) && /tideHp: Number\(env\.TIDE_HP \|\| 40\)/.test(srv) && /tideHit: Number\(env\.TIDE_HIT \|\| 8\)/.test(srv) && /tideGem: Number\(env\.TIDE_GEM \|\| 5\)/.test(srv));
ok('波次记进库、没打完的池子不跨重启', /tide_round integer default 0/.test(dbjs) && /\['world', 'tide_round', 'integer default 0'\]/.test(dbjs) && /tideRound: r\.tide_round \| 0, tideAlive: false/.test(srv));
ok('潮的快照字段不与消息类型重名', /tr: w\.tideRound, ta: w\.tideAlive \? 1 : 0, th: w\.tideHp, tm: w\.tideMax/.test(srv) && /tideRound: w\.tr \| 0, tideAlive: !!w\.ta, tideHp: w\.th \| 0, tideMax: w\.tm \| 0/.test(netjs));

// ---- 合奏：两个人在同一处做出同一个动作（复用已有的表情上行，判定与发钱都在服务端）
const duetSrv = (srv.match(/function pickDuetMate[\s\S]*?\n}/) || [''])[0];
const duetCli = (src.match(/onDuet: \(e\) => \{[\s\S]*?\n    \},/) || [''])[0];
const duetHint = (src.match(/function hintDuet\(\)[\s\S]*?\n}/) || [''])[0];
const duetEmote = (src.match(/function doEmote[\s\S]*?\n}/) || [''])[0];
const duetKeys = (tpl.match(/<b>1 ~ 6<\/b><span>([^<]*)<\/span>/) || ['', ''])[1];
ok('合奏不新增上行消息：还是那条 em，服务端只是多看了一眼时间戳与距离', /broadcastExcept\(lm, p\.id, \{ t: 'em', p: p\.id, e, u: p\.acct \|\| '' \}\)/.test(srv) && /const mate = pickDuetMate\(p, e, lm, t\)/.test(srv) && !/case 'du[a-z]*':/.test(srv));
ok('回响窗口比表情自己的 1.5s 冷却宽一档', /const DUET_WINDOW = 3000/.test(srv) && /t - p\.lastEm < 1500/.test(srv));
ok('配上对就把两边的回响一起清空，第三个人不会把同一声接走', /if \(!mate\) \{ p\.echo = \{ e, t \}; return; \}/.test(srv) && /p\.echo = null; mate\.echo = null;/.test(srv));
ok('合奏要两个人：同一账号开两个窗不算', /if \(q\.acct && q\.acct === p\.acct\) continue;/.test(duetSrv) && /if \(q === p \|\| !q\.joined\) continue;/.test(duetSrv));
ok('近到才算同一处，且只在还没冷却的人里挑', /if \(dist > cfg\.duetDist\) continue;/.test(duetSrv) && /if \(t - \(q\.lastDuet \|\| 0\) < cfg\.duetMs\) \{ stats\.dRej\+\+; continue; \}/.test(duetSrv));
ok('距离认的是服务端记录的位置，不是客户端自报', /Math\.hypot\(p\.x - q\.x, p\.z - q\.z\)/.test(duetSrv) && !/d\.(x|z)/.test(duetSrv));
ok('没身份的连接也能合奏，只是没有账本可记', /if \(!p\.acct \|\| !p\.prog\) return;/.test(srv.match(/function duetCredit[\s\S]*?\n}/)?.[0] || ''), (srv.match(/function duetCredit[\s\S]*?\n}/) || [''])[0].replace(/\n\s*/g, ' ').slice(0, 120));
ok('冷却之内动作照样合、钱不再发（duetCredit 在配对判定之后）', srv.indexOf('const mate = pickDuetMate') < srv.indexOf('duetCredit(p, cfg.duetGem, t)') && /p\.lastDuet = t;/.test(srv));
ok('合奏的三个阈值都能用环境变量调', /duetMs: Number\(env\.DUET_MS \|\| 90000\)/.test(srv) && /duetGem: Number\(env\.DUET_GEM \|\| 1\)/.test(srv) && /duetDist: Number\(env\.DUET_DIST \|\| 9\)/.test(srv));
ok('合奏的次数与被拒都进 metrics', /duets: stats\.duets, duet_rejected: stats\.dRej/.test(srv) && /stats\.duets\+\+/.test(srv));
ok('下发只带「谁与谁、什么动作、在哪儿、给几枚」', /broadcastAll\(lm, \{ t: 'du', a: p\.id, b: mate\.id, na: p\.name, nb: mate\.name, e, x, z, g: cfg\.duetGem \}\)/.test(srv) && /case 'du'/.test(netjs) && /api\.onDuet\?\.\(\{ a: d\.a, b: d\.b, na: d\.na \|\| '', nb: d\.nb \|\| ''/.test(netjs));
ok('六种动作各有各的说法，六句都齐', /const DUET_TXT = \{ (wave|heart)/.test(src) && (src.match(/const DUET_TXT = \{([^}]*)\}/)?.[1].match(/:/g) || []).length === 6, (src.match(/const DUET_TXT = \{([^}]*)\}/) || [, ''])[1]);
ok('客户端收到合奏只放烟花说一句，一分星尘也不自己加', /launchFirework\(e\.x, e\.z\)/.test(duetCli) && /markFeat\('feat_duet'\)/.test(duetCli) && !/prog\.gem/.test(duetCli) && !/gainGem\(/.test(duetCli));
ok('不是当事人才听到旁观的说法', /const mine = e\.a === net\.pid \|\| e\.b === net\.pid;/.test(duetCli) && /else if \(e\.na && e\.nb\)/.test(duetCli));
ok('合奏也不动镜头（容易晕的人的硬约束）', !/shake\(/.test(duetCli) && !/shake\(/.test(duetHint));
ok('身旁有人时提示一次合奏的玩法', /duetHinted/.test(duetHint) && /toast\('身旁有人/.test(duetHint) && /  hintDuet\(\);/.test(duetEmote) && !/shake\(/.test(duetHint));
ok('提示用的距离与服务端的 DUET_DIST 同数', /const DUET_NEAR = 9/.test(src), (srv.match(/duetDist: Number\(env\.DUET_DIST \|\| (\d+)\)/) || [])[1]);
ok('合奏记进入图鉴的一页', /\['feat_duet', '合奏'/.test(src));
ok('按键表与帮助都教了合奏', /与同伴站在同一处做同一个动作＝合奏/.test(duetKeys) && /表情动作（与同伴同处同做＝合奏）/.test(tpl), duetKeys);
ok('测试要能看见合奏放了烟花', /fwSeen\+\+;/.test(src) && /let fwSeen = 0/.test(src) && /fw: launchFirework/.test(src));

// ---- 天气联动：天不只换风景，也换规则（雨里的星屑更润 / 流星夜的愿望 / 樱吹雪托滑翔 / 薄雾里鹿带路）
const wxjs = readFileSync(ROOT + 'server/weather.js', 'utf8');
const WX_ORDER = (wxjs.match(/export const WEATHER = \[([^\]]*)\]/) || ['', ''])[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
const WX_NAMES = ((src.match(/const WEATHER_NAME = \[([^\]]*)\]/) || ['', ''])[1].match(/'[^']+'/g) || []).map((s) => s.replace(/'/g, ''));
ok('天气表只写在一处（服务端那份是权威）', WX_ORDER.join(',') === 'clear,petal,rain,fog,meteor' && /rain \? 2 : 1/.test(wxjs) && /meteor \? 2 : 0/.test(wxjs) && /petal \? 0\.55 : 1/.test(wxjs) && /fog \? 3\.2 : 9/.test(wxjs));
ok('五种天的序号与名字前后端一致', WX_NAMES.length === WX_ORDER.length && WX_NAMES[2] === '细雨' && WX_NAMES[3] === '薄雾' && WX_NAMES[4] === '流星夜', WX_NAMES.join('/'));
ok('客户端镜像的是同一张表（四个数字不许分叉）', /const WX_SHARD_GEM = \[1, 1, 2, 1, 1\]/.test(src) && /const WX_WISH_GEM = \[0, 0, 0, 0, 2\]/.test(src) && /const WX_GLIDE_MUL = \[1, 0\.55, 1, 1, 1\]/.test(src) && /const WX_DEER_FLEE = \[9, 9, 9, 3\.2, 9\]/.test(src));
const pwSrc = (src.match(/const playWeather = \(\) => [^\n]*/) || [''])[0];
ok('规则看的是这条线实际的天，不是「要不要看天气」的开关', /clamp\(net\.world\.weather \| 0/.test(pwSrc) && !/SET\.weather/.test(pwSrc), pwSrc);
ok('雨与流星的奖励由记账的那边加发', /p\.prog\.gem = \(p\.prog\.gem \| 0\) \+ shardGem\(w\.weather\)/.test(srv) && /if \(wished\) p\.prog\.gem = \(p\.prog\.gem \| 0\) \+ wishGem\(w\.weather\)/.test(srv));
ok('许愿的判定只认「这一愿确实往前走了一格」', /if \(wi != null && wi > w\.wish && wi <= w\.wish \+ 1\) \{ w\.wish = wi; ch = true; wished = true; \}/.test(srv));
ok('单机走的是同一张天气表（断了线手感不分叉）', /const wg = WX_WISH_GEM\[playWeather\(\)\]/.test(src) && /if \(!serverGrowth\(\)\) gainGem\(wg\)/.test(src));
ok('薄雾里的白鹿认路：朝最近一枚没被采走的星屑走', /const s = guiding \? nearestShard\(d\.root\.position\.x, d\.root\.position\.z, 70\) : null/.test(src) && /if \(s\.taken \|\| \(net\.state === 'online' && net\.shardTaken\(s\.x, s\.z\)\)\) continue;/.test(src));
ok('鹿带的是一次路，七秒后重新看一眼', /d\.gx = s\.x; d\.gz = s\.z; d\.guideT = 7/.test(src) && /else if \(d\.guideT > 0 && d\.gx != null\)/.test(src));
ok('变天时顺带说一句这天能做什么', /WEATHER_NAME\[c\] \+ '落到了这条分线上：' \+ WX_HINT\[c\]/.test(src) && /const WX_HINT = \['寻常的一天'/.test(src));
ok('服务端能把天气钉住（演示服与回归测试用），钉住就不再轮转', /const WEATHER_PIN = WEATHER\.indexOf\(env\.WEATHER_PIN \|\| ''\)/.test(srv) && /if \(WEATHER_PIN < 0 && t >= w\.weatherAt\)/.test(srv) && /WEATHER\[r\.weather \| 0\]/.test(srv));
const wxLife = (src.match(/function updateLife[\s\S]*?\n  if \(shrooms\)[\s\S]*?\n}/) || [''])[0];
const wxWx = (src.match(/function updateWeather[\s\S]*?\n}/) || [''])[0];
ok('天气玩法不动镜头（容易晕的人的硬约束）', wxLife.length > 300 && wxWx.length > 200 && !/shake\(/.test(wxLife) && !/shake\(/.test(wxWx));
ok('天气规则改口一处即可（客户端没有任何硬编码的 9 米躲避）', !/dist < 9 \? 2\.4/.test(src));

console.log(R.join('\n'));
const failed = R.filter((x) => x.startsWith('FAIL')).length;
console.log(failed ? `WIRING FAIL (${failed}/${R.length})` : `WIRING PASS (${R.length} 项)`);
process.exit(failed ? 1 : 0);
