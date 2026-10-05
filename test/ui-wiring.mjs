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
ok('开始冒险时保持同步联机界面', /startBtn[\s\S]{0,200}mpSync\(\)/.test(src));

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

console.log(R.join('\n'));
const failed = R.filter((x) => x.startsWith('FAIL')).length;
console.log(failed ? `WIRING FAIL (${failed}/${R.length})` : `WIRING PASS (${R.length} 项)`);
process.exit(failed ? 1 : 0);
