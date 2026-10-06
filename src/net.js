// 多人联网层 (P1)：WebSocket 客户端 + 远端玩家渲染/插值
// 协议与设计见 docs/server-design.md
import * as THREE from 'three';
import { clamp, lerp, lerpAngle } from './noise.js';

const LOOKS = [
  { hair: 0xff9ec8, eye: 0x3fd3e8, top: 0xfdfbff, skirt: 0x2a3270, accent: 0xe03a4e, scarf: 0xff9240, style: 'twin' },
  { hair: 0x7fd4ff, eye: 0xffb86f, top: 0xfff4e0, skirt: 0x274a6d, accent: 0x3fa9e0, scarf: 0xff6fa8, style: 'pony' },
  { hair: 0xc49aff, eye: 0x8be36a, top: 0xf2e8ff, skirt: 0x3a2a60, accent: 0xb58cff, scarf: 0x6fd8ff, style: 'short' },
  { hair: 0xffc06a, eye: 0xff7fa8, top: 0xffe9f2, skirt: 0x6d2a4a, accent: 0xffb86f, scarf: 0xa8ff9a, style: 'twin' },
  { hair: 0x6affd4, eye: 0xffd36b, top: 0xe8fff6, skirt: 0x2a5a50, accent: 0x40e0b0, scarf: 0xff9ad0, style: 'long' },
];
function hash36(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function lookFor(pid, look) {
  if (look && typeof look === 'object' && !Array.isArray(look)) {
    const o = {};
    for (const k of ['hair', 'eye', 'top', 'skirt', 'accent', 'scarf', 'style']) {
      const v = look[k];
      if (k === 'style' ? typeof v === 'string' : typeof v === 'number' && v >= 0 && v <= 0xffffff) o[k] = v;
    }
    if (Array.isArray(look.acc)) o.acc = look.acc.filter((x) => typeof x === 'string').slice(0, 2);
    if (Object.keys(o).length) return o;
  }
  return { ...LOOKS[hash36(pid) % LOOKS.length] };
}

export function defaultLook(seed) {
  return { ...lookFor(String(seed == null ? '旅人' : seed)) };
}

export function textSprite(text, { bg, fg, font, h }) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 34;
  c.width = w; c.height = h;
  g.font = font;
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(1, 2, w - 2, h - 4, (h - 4) / 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 3; g.stroke();
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const sy = h / 46 * 0.58;
  s.scale.set(w / 46 * 0.58, sy, 1);
  s.renderOrder = 16;
  s.userData.aspect = w / h;
  return s;
}
const FONT = '900 30px "Noto Sans SC","Microsoft YaHei",sans-serif';
export const EMOTES = { wave: '\ud83d\udc4b', heart: '\u2764', up: '\ud83d\udc4d', spark: '\u2728', bow: '\ud83d\ude47', dance: '\ud83d\udc83' }; // 均为 Emoji 1.0 字形，兼容性安全
export const GESTURE_DUR = { bow: 1.5, dance: 2.6 }; // 动作时长（秒）：客户端与远端共用一份，免得两头都数错
export function iconSprite(icon) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,.94)';
  g.beginPath(); g.arc(48, 48, 44, 0, 7); g.fill();
  g.strokeStyle = '#ff8fb8'; g.lineWidth = 5; g.stroke();
  g.font = '54px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(icon, 48, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(0.9, 0.9, 1);
  s.renderOrder = 17;
  return s;
}

class Remote {
  constructor(api, id, name, x, y, z, yaw, look, pv, acct) {
    this.id = id; this.name = name; this.acct = acct || null; // 静音/举报要按人不按连接：匿名旅伴没有 acct
    this.pvp = !!pv;
    this.char = api.buildCharacter({ ...lookFor(id, look), glider: true });
    this.gx = x; this.gy = y; this.gz = z; this.gyaw = yaw;
    this.tx = x; this.ty = y; this.tz = z; this.tyaw = yaw;
    this.a = { sp: 0, glid: 0, sw: 0, air: 0, hit: 0, dead: 0 };
    this.hurtT = 0; this.bubble = null; this.bubbleT = 0; this.gesture = null;
    this.label = textSprite(name, { bg: 'rgba(59,42,90,.62)', fg: '#fff', font: FONT, h: 46 });
    api.scene.add(this.char.root, this.label);
    this.apply(0, api);
  }
  snap(x, y, z, yaw, a) { this.tx = x; this.ty = y; this.tz = z; this.tyaw = yaw; this.a = a || this.a; }
  showBubble(sprite, ttl) {
    if (this.bubble) { this.bubble.parent?.remove?.(this.bubble); this.bubble.material.map.dispose(); this.bubble.material.dispose(); }
    this.bubble = sprite;
    this.bubbleT = ttl;
    this.char.root.parent?.add?.(this.bubble);
  }
  say(text) {
    const t = text.length > 16 ? text.slice(0, 16) + '…' : text;
    this.showBubble(textSprite(t, { bg: 'rgba(255,255,255,.94)', fg: '#3b2a5a', font: '700 26px "Noto Sans SC",sans-serif', h: 40 }), 4.5);
  }
  emote(kind) {
    const icon = EMOTES[kind];
    if (!icon) return;
    this.showBubble(iconSprite(icon), 1.8);
    if (kind === 'bow' || kind === 'dance') this.gesture = { k: kind, t: 0 };
  }
  hurt() { this.char.flash = 1; }
  // 换装：角色是整套网格，改配色只能重建，旧的一定要 dispose 干净否则显存泄漏
  relook(api, look) {
    if (!look) return;
    const b = this.bubble;
    this.bubble = null;
    api.scene.remove(this.char.root);
    this.char.mats?.forEach?.((m) => m.dispose());
    this.char = api.buildCharacter({ ...lookFor(this.id, look), glider: true });
    api.scene.add(this.char.root);
    if (b) { this.bubble = b; this.bubbleT = Math.max(this.bubbleT, 0.6); api.scene.add(b); }
  }
  apply(dt, api) {
    const k = 1 - Math.exp(-dt * 9);
    const ground = api.groundAt(this.tx, this.tz, 1000);
    const px = this.gx, pz = this.gz;
    this.gx = lerp(this.gx, this.tx, k);
    this.gz = lerp(this.gz, this.tz, k);
    const gy = Math.max(this.ty, ground);
    this.gy = lerp(this.gy, gy, dt > 0.4 ? 1 : 1 - Math.exp(-dt * 7));
    this.gyaw = lerpAngle(this.gyaw, this.tyaw, 1 - Math.exp(-dt * 8));
    const vx = (this.gx - px) / Math.max(dt, 1e-4), vz = (this.gz - pz) / Math.max(dt, 1e-4);
    const fwd = vx * Math.sin(this.gyaw) + vz * Math.cos(this.gyaw);
    const side = vx * Math.cos(this.gyaw) - vz * Math.sin(this.gyaw);
    if (this.a.hit) this.hurtT = 0.35;
    this.hurtT = Math.max(0, this.hurtT - dt);
    if (this.gesture) {
      const dur = GESTURE_DUR[this.gesture.k] || 1.4;
      this.gesture.t += dt;
      if (this.gesture.t >= dur) this.gesture = null;
    }
    this.char.animate(dt, {
      speed: clamp(Math.hypot(vx, vz) / 9, 0, 1.6), air: !!this.a.air && !this.a.glid, vy: 0,
      glide: !!this.a.glid, swim: !!this.a.sw, atk: null, cast: false, hurt: this.hurtT > 0,
      gesture: this.gesture && !this.a.sw && !this.a.glid ? this.gesture.k : null,
      gestureAmt: this.gesture ? Math.sin(Math.PI * Math.min(1, this.gesture.t / (GESTURE_DUR[this.gesture.k] || 1.4))) : 0,
      lf: fwd, ls: side,
    });
    this.char.root.position.set(this.gx, this.gy, this.gz);
    this.char.root.rotation.y = this.gyaw;
    this.label.position.set(this.gx, this.gy + 2.42 + Math.sin(api.clock * 2.6) * 0.06, this.gz);
    if (this.bubble) {
      this.bubbleT -= dt;
      this.bubble.position.set(this.gx, this.gy + 3.1, this.gz);
      this.bubble.material.opacity = clamp(this.bubbleT / 0.6, 0, 1);
      if (this.bubbleT <= 0) {
        this.bubble.parent?.remove?.(this.bubble);
        this.bubble.material.map.dispose(); this.bubble.material.dispose();
        this.bubble = null;
      }
    }
  }
  dispose(api) {
    api.scene.remove(this.char.root, this.label);
    this.char.mats?.forEach?.((m) => m.dispose());
    this.label.material.map.dispose(); this.label.material.dispose();
    if (this.bubble) { api.scene.remove(this.bubble); this.bubble.material.map.dispose(); }
  }
}

export class Net {
  constructor() {
    this.api = null;
    this.ws = null; this.state = 'off'; // off | connecting | online | lost
    this.pid = null; this.tok = null; this.me = null;
    this.acct = null; this.prog = null; this.record = null; this.world = null;
    this.gearSpec = null;  // 成长树定义由服务端下发，价格不在前端重复维护一份
    this.taken = new Set(); // 本分线已被采走的碎片「整数坐标」，服务端给的全量 + 后续增量
    this.remotes = new Map();
    this.boards = new Map(); // 留言石碑 pid -> {p,x,z,s,by,l}，主人离开后仍然留在世界里
    this.sendT = 0; this.retry = 0; this.profile = null; this.myPvp = false;
    this.needRs = true; this.lx = null; this.lz = null;
    // ?lane=N 深链：约好同一条分线再进世界，否则人散了各走一边
    const q = new URLSearchParams(location.search).get('lane');
    this.wantLane = Math.min(3, Math.max(0, Number(q) || 0)); this.lane = this.wantLane;
    this.url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + (location.host || 'localhost:8770') + '/ws';
  }
  init(api) {
    this.api = api;
    this.tok = sessionStorage.getItem('aw.net.tok') || null;
  }
  // ---------------------------------------------------------------- 账号（HTTP）
  // 凭据只存在于服务端下发的 HttpOnly Cookie：前端读不到也不需要读，带上同源 cookie 就行
  httpBase() { return this.url.replace(/^ws/i, 'http').replace(/\/ws\/?$/, ''); }
  async _api(path, body) {
    try {
      const opt = body === undefined
        ? { credentials: 'same-origin' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const r = await fetch(this.httpBase() + path, opt);
      return { status: r.status, j: await r.json().catch(() => null) };
    } catch { return { status: 0, j: null }; } // 直接双击 html 打开、或指向别的主机时没有可用后端：安静地当匿名玩家
  }
  // 游客自动开号：什么都不用填，进世界就已经有身份，进度自然落库
  async whoAmI() {
    const m = await this._api('/api/me');
    if (m.j && !m.j.anon) { this.acct = m.j; return m.j; }
    if (!m.j) { this.acct = null; return null; }
    const g = await this._api('/api/guest', {});
    this.acct = g.j && g.j.a ? { anon: false, a: g.j.a, n: g.j.n || null, bound: !!g.j.bound } : null;
    return this.acct;
  }
  async bind(n, p) {
    const j = (await this._api('/api/bind', { n, p })).j;
    if (j && !j.err) { this.acct = { ...(this.acct || {}), a: j.a, n: j.n, bound: true }; if (this.me) this.me = { ...this.me, n: j.n, bound: true }; }
    return j || { err: 'offline' };
  }
  async logIn(n, p) {
    const j = (await this._api('/api/login', { n, p })).j;
    if (j && !j.err) { this.acct = { anon: false, a: j.a, n: j.n, bound: true }; this.reconnect(); } // 换了身份要用新 cookie 重连才认得
    return j || { err: 'offline' };
  }
  async logOut() {
    const j = (await this._api('/api/logout', {})).j;
    this.acct = { anon: true };
    this.reconnect();
    return j || { err: 'offline' };
  }
  reconnect() { if (this.profile) { clearTimeout(this.retry); this._open(); } }
  connect(name, look) {
    this.profile = { n: name, look: look || null };
    this._open();
  }
  disconnect() {
    this.profile = null;
    if (this.ws) { const ws = this.ws; this.ws = null; try { ws.send(JSON.stringify({ t: 'leave' })); ws.close(); } catch {} }
    this._setState('off');
  }
  _open() {
    if (!this.profile) return;
    if (this.ws) { const old = this.ws; this.ws = null; try { old.close(); } catch {} } // 重连/重复点击不留幽灵连接
    this._setState('connecting');
    this.outbox = [];
    let ws;
    try { ws = new WebSocket(this.url); } catch { this._setState('lost'); return; }
    // 用 addEventListener：部分运行时对构造后赋值的 on* 回调不派发
    ws.addEventListener('message', (e) => this._onMsg(e.data));
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._setState(this.profile ? 'lost' : 'off');
      if (this.profile) { clearTimeout(this.retry); this.retry = setTimeout(() => this._open(), 3000); }
    });
    this.ws = ws;
    const flush = () => { while (this.outbox.length && this._raw(this.outbox[0])) this.outbox.shift(); };
    ws.addEventListener('open', flush);
    this._send({ t: 'hello', tok: this.tok || undefined });
    if (ws.readyState === 1) flush();
  }
  _raw(s) { try { this.ws.send(s); return true; } catch { return false; } }
  _send(o) {
    const s = JSON.stringify(o);
    if (this.ws && this.ws.readyState === 1) { if (this._raw(s)) return; }
    else if (!this.ws) return;
    // 队列一律「旧→新」，发送失败说明这条比队列里更新，只能追加；
    // 上行被压满时旧位置帧已经过期，丢最老的，别让同伴被一串陈旧帧砸回旧位置
    const ob = this.outbox || (this.outbox = []);
    ob.push(s);
    while (ob.length > 40) ob.shift();
  }
  _drain() {
    if (!this.outbox || !this.outbox.length || !this.ws || this.ws.readyState !== 1) return;
    let i = 0;
    while (i < this.outbox.length && this._raw(this.outbox[i])) i++;
    this.outbox.splice(0, i);
  }
  _onMsg(raw) {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    const api = this.api;
    switch (d.t) {
      case 'hello':
        this.pid = d.pid; this.tok = d.tok;
        sessionStorage.setItem('aw.net.tok', this.tok);
        this._send({ t: 'join', r: 'sakura', l: this.wantLane, p: this.profile });
        break;
      case 'welcome': {
        this.lane = d.lane || 0; // 分线满了会被服务端挪线，以实际落位为准
        this.me = d.me || null;  // 服务端认得的自己（账号 id / 昵称 / 是否绑过密码）
        this.boards.clear(); // welcome 是本线留言的全量快照，重连/换线后不能留着旧线的
        for (const b of d.boards || []) this.boards.set(b.p, b);
        if (d.boards && d.boards.length) api.onBoards?.();
        this.prog = d.prog || null;
        this.record = d.pvp || null;
        this.gearSpec = d.gear || null;
        this.taken = new Set((d.shards || []).map((s) => Math.round(s[0]) + ',' + Math.round(s[1])));
        if (this.myPvp) this._send({ t: 'pv', v: 1 }); // 入房前就开启的切磋开关要补发
        // 重连会在服务端生成全新的 Player（默认坐标在村口），首帧必须声明重同步
        this.needRs = true; this.lx = null; this.lz = null;
        for (const p of d.players || []) if (p.p !== this.pid && !this.remotes.has(p.p))
          this.remotes.set(p.p, new Remote(api, p.p, p.n, p.x, p.y, p.z, p.Y, p.look, p.pv, p.u));
        this.applyWorld(d.world);
        this._setState('online', this.remotes.size + 1);
        api.onWelcome?.(d);
        break;
      }
      case 'roster': {
        const seen = new Set();
        for (const p of d.players || []) {
          if (p.p === this.pid) continue;
          seen.add(p.p);
          let r = this.remotes.get(p.p);
          if (!r) { r = new Remote(api, p.p, p.n, p.x, p.y, p.z, p.Y, p.look, p.pv, p.u); this.remotes.set(p.p, r); api.onPeerJoin?.(p.n); }
          else { r.snap(p.x, p.y, p.z, p.Y, p.a); r.pvp = !!p.pv; r.acct = p.u || r.acct || null; }
        }
        for (const [id, r] of this.remotes) if (!seen.has(id)) { r.dispose(api); this.remotes.delete(id); api.onPeerLeave?.(r.name, id); }
        this._setState('online', seen.size + (this.pid ? 1 : 0));
        break;
      }
      case 'nv':
        for (const s of d.l || []) {
          const r = this.remotes.get(s.p);
          if (r) r.snap(s.x, s.y, s.z, s.Y, s.a);
        }
        break;
      case 'gone': {
        const r = this.remotes.get(d.p);
        if (r) { r.dispose(this.api); this.remotes.delete(d.p); api.onPeerLeave?.(r.name, d.p); this._setState('online'); }
        break;
      }
      case 'msg': {
        const r = this.remotes.get(d.p);
        if (r) r.say(d.m);
        api.onChat?.(d.n, d.m, d.p === this.pid);
        break;
      }
      case 'em': {
        const r = this.remotes.get(d.p);
        if (r) r.emote(d.e);
        api.onPeerEmote?.(d.e, r?.name || '', r);
        break;
      }
      case 'du': // 合奏：两个人在同一处做了同一个动作。星尘是服务端记的，这里只负责让天上响一声
        api.onDuet?.({ a: d.a, b: d.b, na: d.na || '', nb: d.nb || '', e: d.e, x: d.x, z: d.z, g: d.g | 0 });
        break;
      case 'pv': {
        if (d.p === this.pid) break; // 服务端会把开关状态广播回自己，用于换线/重连后对齐
        const r = this.remotes.get(d.p);
        if (r) r.pvp = !!d.v;
        api.onPeerPvp?.(!!d.v, r?.name || '');
        break;
      }
      case 'pk': {
        if (d.s === this.pid) {
          const a = this.remotes.get(d.a);
          api.onPlayerHit?.({ dmg: d.d, from: { x: d.x, z: d.z }, by: a ? a.name : '旅伴' });
        } else {
          const v = this.remotes.get(d.s);
          if (v) { v.hurt(); api.onPeerHit?.(v, d.a === this.pid ? d.d : 0); }
        }
        break;
      }
      case 'pg':
        api.onPing?.({ x: d.x, z: d.z, name: d.n, id: d.p });
        break;
      case 'fw':
        api.onFirework?.({ x: d.x, z: d.z, name: d.n, id: d.p });
        break;
      case 'bo': // 同伴的星屑弹：只有演出价值，伤害由放的人自己那一份世界结算
        api.onPeerBolt?.({ id: d.p, c: d.c, Y: d.Y });
        break;
      case 'td': // 这一波的池子空了：全线同庆，星尘由服务端直接记到每个人头上
        api.onTideDone?.({ round: d.r | 0, gem: d.g | 0 });
        break;
      case 'mb': // 服务端回灌（含自己的），本地按 pid upsert 即可幂等
        this.boards.set(d.p, { p: d.p, x: d.x, z: d.z, s: d.s, by: d.by, l: d.l || 0 });
        api.onBoard?.(this.boards.get(d.p));
        break;
      case 'md':
        if (this.boards.delete(d.p)) api.onBoardGone?.(d.p);
        break;
      case 'ws': // 本分线的权威世界快照（任务阶段、Boss 血量、许愿数）
        this.applyWorld(d);
        api.onWorld?.(this.world);
        break;
      case 'pr': // 只有本人收得到：服务端刚把你的档案改了
        if (d.prog) { this.prog = d.prog; api.onProg?.(d.prog); }
        break;
      case 'sk':
        this.taken.add(d.x + ',' + d.z);
        api.onShardTaken?.(d);
        break;
      case 'lk': {
        const r = this.remotes.get(d.p);
        if (r) { r.relook(api, d.look); api.onPeerLook?.(r); }
        break;
      }
      case 'err':
        api.onNetErr?.(d.code);
        break;
      case 'pong':
        break;
    }
  }
  _setState(s, count) {
    this.state = s;
    this.api?.onNetState?.(s, count ?? this.remotes.size + 1);
  }
  chat(text) {
    const m = text.trim().slice(0, 120);
    if (m && this.state === 'online') this._send({ t: 'ch', m });
  }
  // 玩家间交互：切磋需双方开启；k 为目标 id（t 已被消息类型占用）
  pvp(on) { this.myPvp = !!on; if (this.state === 'online') this._send({ t: 'pv', v: on ? 1 : 0 }); }
  emote(kind) { if (this.state === 'online' && EMOTES[kind]) this._send({ t: 'em', e: kind }); }
  hit(pid, dmg) { if (this.state === 'online' && this.myPvp && pid) this._send({ t: 'pk', k: pid, d: Math.max(1, Math.round(dmg)) }); }
  ping(x, z) {
    if (this.state !== 'online') return false;
    this._send({ t: 'pg', x: +(+x).toFixed(1), z: +(+z).toFixed(1) });
    return true;
  }
  // 烟花是给同线所有人放的：本地先响一声，服务端八秒一次冷却
  firework(x, z) {
    if (this.state !== 'online') return false;
    this._send({ t: 'fw', x: +(+x).toFixed(1), z: +(+z).toFixed(1) });
    return true;
  }
  // 星屑弹：只报「朝哪儿、蓄了多满」，坐标由服务端按它记录的位置补，客户端伪造不了别人的站位
  bolt(c, Y) {
    if (this.state !== 'online') return false;
    this._send({ t: 'bo', c: +(Math.max(0, Math.min(1, +c || 0))).toFixed(2), Y: +(+Y || 0).toFixed(3) });
    return true;
  }
  remote(id) { return this.remotes.get(id) || null; }
  // 留言石碑：文本由服务端过滤与限频，这里只做本地截断，避免把没用的字符发出去
  board(x, z, text) {
    const s = (text || '').trim().slice(0, 24);
    if (!s || this.state !== 'online') return false;
    this._send({ t: 'mb', x: +(+x).toFixed(1), z: +(+z).toFixed(1), s });
    return true;
  }
  boardClear() { if (this.state === 'online') this._send({ t: 'mx' }); }
  boardLike(pid) { if (this.state === 'online' && pid) this._send({ t: 'ml', p: pid }); }
  // 留言石碑按「人」存而不是按连接存：有账号时键是账号 id，匿名时才落在连接 id 上
  boardKey() { return this.me?.a || this.pid; }
  isMineBoard(p) { const k = this.boardKey(); return !!k && p === k; }
  myBoard() { const k = this.boardKey(); return k ? this.boards.get(k) || null : null; }
  // ---------------------------------------------------------------- 世界权威
  // 表现照旧本地预测（移动、伤害数字、拾取动画），结论以服务端下发的为准：
  // 任务阶段只认 +1、同一块碎片一条线只算一次、Boss 单跳伤害封顶。
  applyWorld(w) {
    if (!w) return;
    this.world = {
      stage: w.st | 0, k0: w.k0 | 0, kingAlive: !!w.ka, kingHp: w.kh | 0,
      kingMax: w.km || 0, wish: w.wi | 0, upgraded: !!w.up, weather: w.we | 0,
      tideRound: w.tr | 0, tideAlive: !!w.ta, tideHp: w.th | 0, tideMax: w.tm | 0,
    };
  }
  quest(f) {
    if (this.state !== 'online' || !f) return;
    const o = { t: 'qs' };
    for (const k of ['st', 'k0', 'wi']) if (typeof f[k] === 'number' && isFinite(f[k])) o[k] = Math.round(f[k]);
    if (f.up) o.up = 1;
    if (o.st != null || o.k0 != null || o.wi != null || o.up) this._send(o);
  }
  take(x, z) {
    if (this.state !== 'online') return;
    this._send({ t: 'tk', x: Math.round(x), z: Math.round(z) });
  }
  died() { if (this.state === 'online') this._send({ t: 'qs', de: 1 }); }
  // 成长：余额与等级都由服务端记账，客户端只报「想升哪一级」
  spend(k) { if (this.state === 'online' && this.me?.a && k) this._send({ t: 'sp', k }); }
  claimGrowth(gem, gear, stamps) {
    if (this.state === 'online' && this.me?.a) this._send({ t: 'sq', gem: gem | 0, gear: gear || {}, stamps: stamps || [] });
  }
  shardTaken(x, z) { return this.taken.has(Math.round(x) + ',' + Math.round(z)); }
  // 景点打卡：只报「我到了这里」，去重、限量、奖励都由服务端算
  codex(key) { if (this.state === 'online' && this.me?.a && key) this._send({ t: 'cd', s: key }); }
  // 换装：发完整外观，服务端清洗后广播给同线同伴
  setLook(look) { if (this.state === 'online' && look) this._send({ t: 'lk', look }); }
  kingHit(dmg) {
    if (this.state !== 'online') return;
    this._send({ t: 'kb', d: Math.max(1, Math.round(dmg)) });
  }
  // 史莱姆潮：本地打的每一跳都投进这条分线共用的池子，封顶与限流由服务端定
  tideHit(dmg) {
    if (this.state !== 'online') return;
    this._send({ t: 'th', d: Math.max(1, Math.round(dmg)) });
  }
  // 静音只屏蔽社交信号（说话/动作/呼叫/留言），不抹掉人在世界里的存在
  mute(acct, on = true) {
    if (this.state === 'online' && this.me?.a && acct && acct !== this.me.a) this._send({ t: 'mu', u: acct, on: !!on });
  }
  report(acct, why) {
    if (this.state === 'online' && acct) this._send({ t: 'rp', u: acct, r: String(why || '').slice(0, 60) });
  }
  // 主循环驱动：15Hz 上报本地状态 + 远端插值
  tick(P, G, dt) {
    if (!this.api || !this.profile) return;
    this._drain();
    if (this.ws && this.ws.readyState === 1 && this.state === 'online') {
      this.sendT -= dt;
      if (this.sendT <= 0) {
        this.sendT = 1 / 15;
        // 本地发生瞬移（重生/掉出世界/剧情传送）或刚重连：请求服务端重同步一次位置，
        // 否则速度校验会永远追不上，别人眼里的你就定格在旧坐标上
        if (this.lx != null && Math.hypot(P.pos.x - this.lx, P.pos.z - this.lz) > 12) this.needRs = true;
        this.lx = P.pos.x; this.lz = P.pos.z;
        this._send({
          t: 'st', ts: Date.now(),
          x: +P.pos.x.toFixed(2), y: +P.pos.y.toFixed(2), z: +P.pos.z.toFixed(2), Y: +P.yaw.toFixed(3),
          rs: this.needRs ? 1 : 0,
          a: {
            sp: +(Math.hypot(P.vel.x, P.vel.z)).toFixed(1),
            glid: P.glide ? 1 : 0, sw: P.swim ? 1 : 0, air: !P.grounded && !P.swim ? 1 : 0,
            hit: P.hurtT > 0 ? 1 : 0, dead: P.dead ? 1 : 0,
          },
        });
        this.needRs = false;
      }
    }
    for (const r of this.remotes.values()) r.apply(Math.min(dt, 0.1), this.api);
  }
}

export const net = new Net();
