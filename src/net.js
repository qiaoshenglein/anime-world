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
    if (Object.keys(o).length) return o;
  }
  return { ...LOOKS[hash36(pid) % LOOKS.length] };
}

function textSprite(text, { bg, fg, font, h }) {
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

class Remote {
  constructor(api, id, name, x, y, z, yaw, look) {
    this.id = id; this.name = name;
    this.char = api.buildCharacter({ ...lookFor(id, look), glider: true });
    this.gx = x; this.gy = y; this.gz = z; this.gyaw = yaw;
    this.tx = x; this.ty = y; this.tz = z; this.tyaw = yaw;
    this.a = { sp: 0, glid: 0, sw: 0, air: 0, hit: 0, dead: 0 };
    this.hurtT = 0; this.bubble = null; this.bubbleT = 0;
    this.label = textSprite(name, { bg: 'rgba(59,42,90,.62)', fg: '#fff', font: FONT, h: 46 });
    api.scene.add(this.char.root, this.label);
    this.apply(0, api);
  }
  snap(x, y, z, yaw, a) { this.tx = x; this.ty = y; this.tz = z; this.tyaw = yaw; this.a = a || this.a; }
  say(text) {
    if (this.bubble) { this.bubble.parent?.remove?.(this.bubble); this.bubble.material.map.dispose(); this.bubble.material.dispose(); }
    const t = text.length > 16 ? text.slice(0, 16) + '…' : text;
    this.bubble = textSprite(t, { bg: 'rgba(255,255,255,.94)', fg: '#3b2a5a', font: '700 26px "Noto Sans SC",sans-serif', h: 40 });
    this.bubbleT = 4.5;
    this.char.root.parent?.add?.(this.bubble);
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
    this.char.animate(dt, {
      speed: clamp(Math.hypot(vx, vz) / 9, 0, 1.6), air: !!this.a.air && !this.a.glid, vy: 0,
      glide: !!this.a.glid, swim: !!this.a.sw, atk: null, cast: false, hurt: this.hurtT > 0,
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
    this.pid = null; this.tok = null;
    this.remotes = new Map();
    this.sendT = 0; this.retry = 0; this.profile = null;
    this.url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + (location.host || 'localhost:8770') + '/ws';
  }
  init(api) {
    this.api = api;
    this.tok = sessionStorage.getItem('aw.net.tok') || null;
  }
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
    if (this.ws && this.ws.readyState === 1) { if (!this._raw(s)) (this.outbox || (this.outbox = [])).unshift(s); }
    else if (this.ws) (this.outbox || (this.outbox = [])).push(s);
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
        this._send({ t: 'join', r: 'sakura', l: 0, p: this.profile });
        break;
      case 'welcome': {
        for (const p of d.players || []) if (p.p !== this.pid && !this.remotes.has(p.p))
          this.remotes.set(p.p, new Remote(api, p.p, p.n, p.x, p.y, p.z, p.Y, p.look));
        this._setState('online', this.remotes.size + 1);
        break;
      }
      case 'roster': {
        const seen = new Set();
        for (const p of d.players || []) {
          if (p.p === this.pid) continue;
          seen.add(p.p);
          let r = this.remotes.get(p.p);
          if (!r) { r = new Remote(api, p.p, p.n, p.x, p.y, p.z, p.Y, p.look); this.remotes.set(p.p, r); api.onPeerJoin?.(p.n); }
          else r.snap(p.x, p.y, p.z, p.Y, p.a);
        }
        for (const [id, r] of this.remotes) if (!seen.has(id)) { r.dispose(api); this.remotes.delete(id); api.onPeerLeave?.(r.name); }
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
        if (r) { r.dispose(this.api); this.remotes.delete(d.p); api.onPeerLeave?.(r.name); this._setState('online'); }
        break;
      }
      case 'msg': {
        const r = this.remotes.get(d.p);
        if (r) r.say(d.m);
        api.onChat?.(d.n, d.m, d.p === this.pid);
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
  // 主循环驱动：15Hz 上报本地状态 + 远端插值
  tick(P, G, dt) {
    if (!this.api || !this.profile) return;
    this._drain();
    if (this.ws && this.ws.readyState === 1 && this.state === 'online') {
      this.sendT -= dt;
      if (this.sendT <= 0) {
        this.sendT = 1 / 15;
        this._send({
          t: 'st', ts: Date.now(),
          x: +P.pos.x.toFixed(2), y: +P.pos.y.toFixed(2), z: +P.pos.z.toFixed(2), Y: +P.yaw.toFixed(3),
          a: {
            sp: +(Math.hypot(P.vel.x, P.vel.z)).toFixed(1),
            glid: P.glide ? 1 : 0, sw: P.swim ? 1 : 0, air: !P.grounded && !P.swim ? 1 : 0,
            hit: P.hurtT > 0 ? 1 : 0, dead: P.dead ? 1 : 0,
          },
        });
      }
    }
    for (const r of this.remotes.values()) r.apply(Math.min(dt, 0.1), this.api);
  }
}

export const net = new Net();
