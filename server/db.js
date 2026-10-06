// 账号 / 存档 / 世界状态存储层（bun:sqlite，零外部依赖）
// 打开失败时退回内存模式：联机照常，但账号与进度不跨重启（/healthz 会显示 db:"memory"）
import { Database } from 'bun:sqlite';

const SCHEMA = `
create table if not exists accounts(
  id text primary key, kind text not null default 'guest', name text,
  salt blob, pass blob, look text, lane integer default 0,
  created integer, last_seen integer);
create table if not exists sessions(
  hash text primary key, account text not null, created integer, last_seen integer);
create index if not exists sess_acct on sessions(account);
create table if not exists progress(
  account text primary key, stage integer default 0, k0 integer default 0,
  shards integer default 0, kills integer default 0, deaths integer default 0,
  plays integer default 0, wish integer default 0, upgraded integer default 0,
  gem integer default 0, gear text, codex text, updated integer);
create table if not exists world(
  room text, lane integer, stage integer default 0, k0 integer default 0,
  king_hp integer default 0, king_alive integer default 1, wish integer default 0,
  upgraded integer default 0, weather integer default 0, tide_round integer default 0,
  updated integer, primary key(room, lane));
create table if not exists lane_shard(
  room text, lane integer, x integer, z integer, acct text, at integer,
  primary key(room, lane, x, z));
create table if not exists board(
  account text primary key, room text, lane integer, x real, z real,
  s text, by_who text, at integer, l integer default 0);
create table if not exists board_like(
  board text, liker text, day text, at integer, primary key(board, liker, day));
create table if not exists pvp_day(
  account text, day text, hits integer default 0, dealt integer default 0,
  wins integer default 0, primary key(account, day));
create table if not exists ban(account text primary key, until integer, reason text, at integer, ip text);
create table if not exists ban_ip(ip text primary key, until integer, at integer);
create table if not exists account_ip(account text primary key, ip text, at integer);
create table if not exists mute(account text, target text, at integer, primary key(account, target));
create table if not exists report(
  id integer primary key autoincrement, account text, by_who text, reason text, at integer);
create table if not exists login_fail(ip text primary key, n integer default 0, until integer default 0);
`;

// 旧库补列：add column 在已存在时抛错，直接忽略即可（每次启动都是幂等的）
const MIGRATE = [
  ['world', 'k0', 'integer default 0'],
  ['accounts', 'look', 'text'],
  ['progress', 'wish', 'integer default 0'],
  ['progress', 'gem', 'integer default 0'],
  ['progress', 'gear', 'text'],
  ['progress', 'codex', 'text'],
  ['world', 'weather', 'integer default 0'],
  ['world', 'tide_round', 'integer default 0'],
  ['ban', 'ip', 'text'],
];

export function openDb(file) {
  if (file) {
    try {
      const db = new Database(file);
      db.run('pragma journal_mode=wal');
      db.run('pragma busy_timeout=2000');
      db.run(SCHEMA);
      for (const [t, c, ty] of MIGRATE) { try { db.run(`alter table ${t} add column ${c} ${ty}`); } catch {} }
      return { db, mode: 'file', file };
    } catch (e) {
      console.warn('[db] 无法打开 ' + file + '：' + e.message + ' —— 退回内存模式（账号不跨重启）');
    }
  }
  const db = new Database(':memory:');
  db.run(SCHEMA);
  // 内存模式也走一遍 MIGRATE：两条路径的表结构必须一模一样，
  // 否则「新增一列只补了 MIGRATE」的改动在测试里永远炸不出来，上线才炸
  for (const [t, c, ty] of MIGRATE) { try { db.run(`alter table ${t} add column ${c} ${ty}`); } catch {} }
  return { db, mode: 'memory', file: ':memory:' };
}

// 每天一条战绩记录，跨天自动起新行
export const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class Store {
  constructor(db) {
    this.db = db;
    const q = (s) => db.query(s);
    this.st = {
      acctIns: db.prepare('insert into accounts(id,kind,name,created,last_seen,look,lane) values(?,?,?,?,?,?,?)'),
      acctGet: q('select * from accounts where id=?'),
      acctByName: q('select * from accounts where name=? and kind=\'bound\''),
      acctName: db.prepare('update accounts set name=?, last_seen=? where id=?'),
      acctSeen: db.prepare('update accounts set last_seen=? where id=?'),
      acctLook: db.prepare('update accounts set look=?, lane=? where id=?'),
      acctCred: db.prepare('update accounts set kind=\'bound\', salt=?, pass=?, name=?, last_seen=? where id=?'),
      acctPass: q('select salt,pass,kind from accounts where id=?'),
      sessIns: db.prepare('insert into sessions(hash,account,created,last_seen) values(?,?,?,?)'),
      sessGet: q('select * from sessions where hash=?'),
      sessSeen: db.prepare('update sessions set last_seen=? where hash=?'),
      sessDel: db.prepare('delete from sessions where hash=?'),
      sessDelAcct: db.prepare('delete from sessions where account=?'),
      progGet: q('select * from progress where account=?'),
      progUps: db.prepare(`insert into progress(account,stage,k0,shards,kills,deaths,plays,wish,upgraded,gem,gear,codex,updated)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?)
        on conflict(account) do update set stage=excluded.stage,k0=excluded.k0,shards=excluded.shards,
        kills=excluded.kills,deaths=excluded.deaths,plays=excluded.plays,wish=excluded.wish,
        upgraded=excluded.upgraded,gem=excluded.gem,gear=excluded.gear,codex=excluded.codex,updated=excluded.updated`),
      progBump: db.prepare('update progress set plays=plays+1, updated=? where account=?'),
      worldGet: q('select * from world where room=? and lane=?'),
      worldUps: db.prepare(`insert into world(room,lane,stage,k0,king_hp,king_alive,wish,upgraded,weather,tide_round,updated)
        values(?,?,?,?,?,?,?,?,?,?,?) on conflict(room,lane) do update set stage=excluded.stage,k0=excluded.k0,
        king_hp=excluded.king_hp,king_alive=excluded.king_alive,wish=excluded.wish,
        upgraded=excluded.upgraded,weather=excluded.weather,tide_round=excluded.tide_round,updated=excluded.updated`),
      shardGet: q('select 1 from lane_shard where room=? and lane=? and x=? and z=?'),
      shardIns: db.prepare('insert into lane_shard(room,lane,x,z,acct,at) values(?,?,?,?,?,?)'),
      shardList: q('select x,z from lane_shard where room=? and lane=?'),
      shardCount: q('select count(*) as n from lane_shard where room=? and lane=?'),
      boardList: q('select * from board where room=? and lane=?'),
      boardGet: q('select * from board where account=?'),
      boardUps: db.prepare('insert into board(account,room,lane,x,z,s,by_who,at,l) values(?,?,?,?,?,?,?,?,?) on conflict(account) do update set room=excluded.room,lane=excluded.lane,x=excluded.x,z=excluded.z,s=excluded.s,by_who=excluded.by_who,at=excluded.at,l=excluded.l'),
      boardDel: db.prepare('delete from board where account=?'),
      boardTouch: db.prepare('update board set l=l+1 where account=?'),
      likeHas: q('select 1 from board_like where board=? and liker=? and day=?'),
      likeIns: db.prepare('insert into board_like(board,liker,day,at) values(?,?,?,?)'),
      likeCount: q('select count(*) as n from board_like where board=?'),
      pvpGet: q('select * from pvp_day where account=? and day=?'),
      pvpAdd: db.prepare(`insert into pvp_day(account,day,hits,dealt,wins) values(?,?,?,?,?)
        on conflict(account,day) do update set hits=hits+excluded.hits, dealt=dealt+excluded.dealt, wins=wins+excluded.wins`),
      banGet: q('select * from ban where account=?'),
      banIns: db.prepare('insert into ban(account,until,reason,at,ip) values(?,?,?,?,?) on conflict(account) do update set until=excluded.until,reason=excluded.reason,at=excluded.at,ip=excluded.ip'),
      banDel: db.prepare('delete from ban where account=?'),
      banIpGet: q('select * from ban_ip where ip=?'),
      banIpIns: db.prepare('insert into ban_ip(ip,until,at) values(?,?,?) on conflict(ip) do update set until=excluded.until,at=excluded.at'),
      banIpDel: db.prepare('delete from ban_ip where ip=?'),
      ipUps: db.prepare('insert into account_ip(account,ip,at) values(?,?,?) on conflict(account) do update set ip=excluded.ip,at=excluded.at'),
      ipGet: q('select ip from account_ip where account=?'),
      banList: q('select * from ban where until>? order by until desc'),
      muteList: q('select target from mute where account=?'),
      muteIns: db.prepare('insert or ignore into mute(account,target,at) values(?,?,?)'),
      muteDel: db.prepare('delete from mute where account=? and target=?'),
      reportIns: db.prepare('insert into report(account,by_who,reason,at) values(?,?,?,?)'),
      reportList: q('select * from report order by at desc limit 50'),
      lfGet: q('select * from login_fail where ip=?'),
      lfSet: db.prepare('insert into login_fail(ip,n,until) values(?,?,?) on conflict(ip) do update set n=excluded.n,until=excluded.until'),
      lfClear: db.prepare('delete from login_fail where ip=?'),
    };
  }

  // ---- accounts
  createAccount(kind = 'guest', name = null, look = null, lane = 0) {
    const id = 'a' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const t = Date.now();
    this.st.acctIns.run(id, kind, name, t, t, look ? JSON.stringify(look) : null, lane);
    this.st.progUps.run(id, 0, 0, 0, 0, 0, 1, 0, 0, 0, '{}', '{}', t);
    return this.acct(id);
  }
  acct(id) { const a = this.st.acctGet.get(id); return a ? { ...a, look: a.look ? JSON.parse(a.look) : null } : null; }
  acctByName(name) { return this.st.acctByName.get(name) || null; }
  touch(id) { this.st.acctSeen.run(Date.now(), id); }
  setName(id, name) { this.st.acctName.run(name, Date.now(), id); }
  saveLook(id, look, lane) { this.st.acctLook.run(JSON.stringify(look || null), lane, id); }
  setCredential(id, salt, hash, name) { this.st.acctCred.run(salt, hash, name, Date.now(), id); }
  credential(id) { return this.st.acctPass.get(id) || null; }

  // ---- sessions（库里只存 sha256(token)：拖库也拿不到可用凭据）
  newSession(account) {
    const raw = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    this.st.sessIns.run(this.hash(raw), account, Date.now(), Date.now());
    return raw;
  }
  hash(tok) { return new Bun.CryptoHasher('sha256').update(String(tok)).digest('hex'); }
  session(tok) { return tok ? this.st.sessGet.get(this.hash(tok)) : null; }
  touchSession(tok) { const h = this.hash(tok); const s = this.st.sessGet.get(h); if (s) this.st.sessSeen.run(Date.now(), h); return s; }
  dropSession(tok) { this.st.sessDel.run(this.hash(tok)); }
  dropAllSessions(account) { return this.st.sessDelAcct.run(account).changes; }

  // ---- progress
  // gear/codex 是变长结构，存 JSON 文本；读出来一律给成对象，别让客户端自己解析字符串
  progress(account) {
    const r = this.st.progGet.get(account);
    if (!r) return null;
    r.gem = r.gem | 0;
    try { r.gear = r.gear ? JSON.parse(r.gear) : {}; } catch (e) { r.gear = {}; }
    try { r.codex = r.codex ? JSON.parse(r.codex) : {}; } catch (e) { r.codex = {}; }
    return r;
  }
  saveProgress(account, p) {
    this.st.progUps.run(account, p.stage | 0, p.k0 | 0, p.shards | 0, p.kills | 0, p.deaths | 0,
      p.plays | 0, p.wish | 0, p.upgraded | 0, p.gem | 0, JSON.stringify(p.gear || {}), JSON.stringify(p.codex || {}), Date.now());
  }
  bumpPlays(account) { this.st.progBump.run(Date.now(), account); }

  // ---- world（每条 room+lane 一份，分线之间互不影响）
  world(room, lane) {
    return this.st.worldGet.get(room, lane) || { room, lane, stage: 0, k0: 0, king_hp: 0, king_alive: 1, wish: 0, upgraded: 0, weather: 0, tide_round: 0 };
  }
  saveWorld(room, lane, w) {
    this.st.worldUps.run(room, lane, w.stage | 0, w.k0 | 0, w.king_hp | 0, w.king_alive ? 1 : 0, w.wish | 0, w.upgraded ? 1 : 0, w.weather | 0, w.tide_round | 0, Date.now());
  }

  // ---- shards：坐标做主键，同一块碎片在同一条线上只能被记一次
  shardTaken(room, lane, x, z) { return !!this.st.shardGet.get(room, lane, x, z); }
  takeShard(room, lane, x, z, acct) {
    try { this.st.shardIns.run(room, lane, x, z, acct, Date.now()); return true; } catch { return false; }
  }
  shardList(room, lane) { return this.st.shardList.all(room, lane); }
  shardCount(room, lane) { return this.st.shardCount.get(room, lane).n; }

  // ---- boards
  boardList(room, lane) { return this.st.boardList.all(room, lane); }
  board(account) { return this.st.boardGet.get(account) || null; }
  // 重刻/挪碑不清空已有爱心：心意按 (作者,点赞人,日期) 记账，比碑本身活得久
  putBoard(account, room, lane, x, z, s, byWho) {
    this.st.boardUps.run(account, room, lane, x, z, s, byWho, Date.now(), this.likeCount(account));
  }
  // 收回碑不删点赞记录：那是「谁在哪天心动过」的台账，也是刷心的唯一防线
  // 收回碑不删点赞记录：那是「谁在哪天心动过」的台账，也是刷心的唯一防线
  dropBoard(account) { this.st.boardDel.run(account); }
  likeBoard(account) { this.st.boardTouch.run(account); }
  likedBefore(boardOwner, liker, day = dayKey()) { return !!this.st.likeHas.get(boardOwner, liker, day); }
  // 同一人对同一作者每天只有一颗心：反复立碑刷不出第二颗
  markLiked(boardOwner, liker, day = dayKey()) {
    if (this.likedBefore(boardOwner, liker, day)) return false;
    this.st.likeIns.run(boardOwner, liker, day, Date.now());
    this.likeBoard(boardOwner);
    return true;
  }
  likeCount(boardOwner) { return this.st.likeCount.get(boardOwner).n; }

  // ---- pvp / bans / mutes / reports / login throttle
  pvpToday(account, day = dayKey()) { return this.st.pvpGet.get(account, day) || { account, day, hits: 0, dealt: 0, wins: 0 }; }
  addPvp(account, hits, dealt, win, day = dayKey()) { this.st.pvpAdd.run(account, day, hits, dealt, win ? 1 : 0); }
  banned(account) {
    const b = this.st.banGet.get(account);
    return b && b.until > Date.now() ? b : null;
  }
  noteIp(account, ip) { if (account && ip && ip !== 'unknown') this.st.ipUps.run(account, ip, Date.now()); }
  lastIp(account) { return this.st.ipGet.get(account)?.ip || null; }
  // 只封账号太容易被绕：丢掉 cookie 换个匿名连接就回来了。封号时一并封它最近使用的 IP。
  ban(account, minutes, reason) {
    const until = Date.now() + minutes * 60000;
    const ip = this.lastIp(account);
    this.st.banIns.run(account, until, reason || '', Date.now(), ip);
    if (ip) this.st.banIpIns.run(ip, until, Date.now());
    return ip;
  }
  unban(account) {
    const b = this.st.banGet.get(account);
    if (b?.ip) this.st.banIpDel.run(b.ip);
    return this.st.banDel.run(account).changes > 0;
  }
  bannedIp(ip) { const b = ip && this.st.banIpGet.get(ip); return b && b.until > Date.now() ? b : null; }
  banList() { return this.st.banList.all(Date.now()); }
  mutes(account) { return new Set(this.st.muteList.all(account).map((r) => r.target)); }
  mute(account, target) { if (account && target && account !== target) this.st.muteIns.run(account, target, Date.now()); }
  unmute(account, target) { this.st.muteDel.run(account, target); }
  report(account, byWho, reason) { this.st.reportIns.run(account, byWho, (reason || '').slice(0, 120), Date.now()); }
  reports() { return this.st.reportList.all(); }
  loginFail(ip) { return this.st.lfGet.get(ip) || { ip, n: 0, until: 0 }; }
  noteLoginFail(ip, lockMs) {
    const cur = this.loginFail(ip);
    const n = cur.n + 1;
    this.st.lfSet.run(ip, n, n >= 5 ? Date.now() + lockMs : 0);
    return n;
  }
  clearLoginFail(ip) { this.st.lfClear.run(ip); }

  counts() {
    const one = (s) => this.db.query(s).get()?.n || 0;
    return {
      accounts: one('select count(*) as n from accounts'),
      bound: one("select count(*) as n from accounts where kind='bound'"),
      sessions: one('select count(*) as n from sessions'),
      boards: one('select count(*) as n from board'),
      shards: one('select count(*) as n from lane_shard'),
      reports: one('select count(*) as n from report'),
    };
  }
}
