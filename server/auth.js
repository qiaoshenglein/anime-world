// 账号与会话：游客自动开号，可选绑定密码（scrypt）；凭据只放 HttpOnly Cookie
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';

const scrypt = (pw, salt) => new Promise((res, rej) =>
  _scrypt(pw, salt, 32, (e, key) => (e ? rej(e) : res(key))));

export const NAME_RE = /^[\w㐀-䶿一-鿿 ·A-Za-z0-9-]{1,16}$/;
export const COOKIE = 'aw_sid';
const MAX_BODY = 8192;

export function parseCookie(req) {
  const h = req.headers.get('cookie');
  if (!h) return {};
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// HttpOnly + SameSite=Lax：JS 读不到凭据，跨站表单也带不上
export function cookieSet(sid, maxAge = 60 * 60 * 24 * 180) {
  return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
export function cookieKill() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// 只接受 application/json：跨站表单发不出这个 content-type，等于一道廉价的 CSRF 门
export async function jsonBody(req) {
  const ct = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') throw new Error('需要 application/json');
  const buf = await req.arrayBuffer();
  if (!buf || buf.byteLength > MAX_BODY) throw new Error('请求体过大');
  const d = JSON.parse(new TextDecoder().decode(buf));
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('格式不对');
  return d;
}

export async function hashPass(pw, salt = randomBytes(16)) {
  return { salt, key: await scrypt(pw, salt) };
}
export async function checkPass(pw, salt, key) {
  if (typeof pw !== 'string' || !pw.length || pw.length > 200) return false;
  const k = await scrypt(pw, salt);
  return k.length === key.length && timingSafeEqual(k, key);
}

export const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });

export class Auth {
  constructor(store, cfg = {}) {
    this.store = store;
    this.lockMs = cfg.loginLockMs || 10 * 60 * 1000;
    this.maxFails = cfg.loginMaxFails || 5;
    this.bursts = new Map(); // 注册/绑定节流：ip -> [时间戳]
  }
  // 同一 IP 每分钟最多开/绑 N 个号，挡住脚本批量注册
  throttle(ip, limit = 12, windowMs = 60000) {
    const t = Date.now();
    const arr = (this.bursts.get(ip) || []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) return false;
    arr.push(t);
    this.bursts.set(ip, arr);
    if (this.bursts.size > 4096) this.bursts.clear();
    return true;
  }
  guest() {
    const a = this.store.createAccount('guest');
    const sid = this.store.newSession(a.id);
    return { account: a.id, sid, bound: false, name: null };
  }
  async login(name, pw, ip) {
    const f = this.store.loginFail(ip);
    if (f.until > Date.now()) return { err: 'locked', retry: Math.ceil((f.until - Date.now()) / 1000) };
    const a = this.store.acctByName(String(name || '').trim());
    if (!a || a.kind !== 'bound' || !a.salt || !a.pass) { this.store.noteLoginFail(ip, this.lockMs); return { err: 'bad' }; }
    const ok = await checkPass(pw, new Uint8Array(a.salt), new Uint8Array(a.pass));
    if (!ok) { const n = this.store.noteLoginFail(ip, this.lockMs); return { err: 'bad', left: Math.max(0, this.maxFails - n) }; }
    this.store.clearLoginFail(ip);
    const sid = this.store.newSession(a.id);
    return { account: a.id, sid, bound: true, name: a.name };
  }
  // 把当前游客号转正：名字唯一 + 密码强度下限
  async bind(sid, name, pw) {
    const s = this.store.session(sid);
    if (!s) return { err: 'anon' };
    const a = this.store.acct(s.account);
    if (!a) return { err: 'anon' };
    if (a.kind === 'bound') return { err: 'already', account: a.id, name: a.name };
    const nm = String(name || '').trim();
    const n = a.name && !nm ? a.name : nm;
    if (!NAME_RE.test(n)) return { err: 'name' };
    if (this.store.acctByName(n)) return { err: 'taken' };
    if (typeof pw !== 'string' || pw.length < 6 || pw.length > 200) return { err: 'weak' };
    const { salt, key } = await hashPass(pw);
    this.store.setCredential(a.id, salt, key, n);
    return { account: a.id, name: n, bound: true };
  }
  who(sid) {
    if (!sid) return null;
    const s = this.store.touchSession(sid);
    return s ? { account: s.account, name: this.store.acct(s.account)?.name || null } : null;
  }
  logout(sid) { if (sid) this.store.dropSession(sid); }
}
