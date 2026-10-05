// 供浏览器页配对的队友：入指定分线、绕圈移动、发聊天
const URL_ = process.env.URL || 'ws://localhost:8770/ws';
const LANE = Number(process.env.LANE || 0);
const NAME = process.env.NAME || '浏览器队友';
const ws = new WebSocket(URL_);
let inRoom = false, ang = 0;
ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello' })));
ws.addEventListener('message', (e) => {
  const d = JSON.parse(String(e.data));
  if (d.t === 'hello') ws.send(JSON.stringify({ t: 'join', r: 'sakura', l: LANE, p: { n: NAME } }));
  if (d.t === 'welcome') { inRoom = true; console.error('peer in lane ' + LANE + ' as ' + d.pid); }
});
setInterval(() => {
  if (!inRoom) return;
  ang += 0.3;
  ws.send(JSON.stringify({ t: 'st', ts: Date.now(), x: +(2 + Math.sin(ang) * 3).toFixed(2), y: 2, z: +(12 + Math.cos(ang) * 3).toFixed(2), Y: +ang.toFixed(2), a: { sp: 6 } }));
}, 66);
setInterval(() => ws.send(JSON.stringify({ t: 'ch', m: '你好，浏览器里的旅人' })), 4000);
setTimeout(() => ws.send(JSON.stringify({ t: 'ch', m: '你好，浏览器里的旅人' })), 1500);
setTimeout(() => process.exit(0), Number(process.env.TIMEOUT || 20000));
