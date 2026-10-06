// 运维命令行：封禁 / 解封 / 查号 / 看举报
// 用法: AW_DB=/path/world.db bun server/cli.js <命令> [参数]
//   ban <账号或名字> [分钟=60] [备注]     封一个旅人
//   unban <账号或名字>                    解封
//   bans                                 当前生效的封禁
//   who <账号或名字>                      档案、进度、今日战绩
//   accounts [N=20]                       最近活跃的账号
//   reports                               最近 50 条举报
//   mute <账号> <被静音账号> / unmute ... 代客处理静音
import { openDb, Store, dayKey } from './db.js';

const file = process.env.AW_DB || '';
if (!file) {
  console.error('需要先在服务端 .env 里配好 AW_DB（内存模式没有可操作的库）。例：AW_DB=/var/lib/anime-world/world.db bun server/cli.js bans');
  process.exit(2);
}
const store = new Store(openDb(file).db);
const [cmd, a, b, c] = process.argv.slice(2);
const find = (s) => (s || '').startsWith('a') && s.length >= 12 ? store.acct(s) : store.acctByName(s);

if (!cmd) { console.error('用法见文件头注释'); process.exit(2); }

switch (cmd) {
  case 'ban': {
    const acc = find(a);
    if (!acc) { console.error('找不到账号：' + a); process.exit(1); }
    const mins = Number(b) || 60;
    store.ban(acc.id, mins, c || 'cli');
    console.log(`已封禁 ${acc.name || acc.id} 至 ${new Date(Date.now() + mins * 60000).toLocaleString()}`);
    break;
  }
  case 'unban': {
    const acc = find(a);
    if (!acc) { console.error('找不到账号：' + a); process.exit(1); }
    console.log(store.unban(acc.id) ? '已解封 ' + (acc.name || acc.id) : '本来就没被封');
    break;
  }
  case 'bans':
    for (const x of store.banList()) console.log(`${x.account}\t至 ${new Date(x.until).toLocaleString()}\t${x.reason || ''}`);
    break;
  case 'who': {
    const acc = find(a);
    if (!acc) { console.error('找不到账号：' + a); process.exit(1); }
    const p = store.progress(acc.id), w = store.pvpToday(acc.id), bd = store.board(acc.id);
    console.log(JSON.stringify({
      id: acc.id, name: acc.name, kind: acc.kind, created: new Date(acc.created).toISOString(),
      last_seen: acc.last_seen ? new Date(acc.last_seen).toISOString() : null,
      progress: p, pvp_today: w, board: bd ? { s: bd.s, x: bd.x, z: bd.z, hearts: bd.l } : null,
      banned: store.banned(acc.id),
    }, null, 2));
    break;
  }
  case 'accounts':
    for (const r of store.db.query('select id,name,kind,last_seen from accounts order by last_seen desc limit ?').all(Number(a) || 20))
      console.log(`${r.id}\t${r.kind}\t${r.name || '-'}\t${r.last_seen ? new Date(r.last_seen).toLocaleString() : '-'}`);
    break;
  case 'reports':
    for (const r of store.reports()) console.log(`${new Date(r.at).toLocaleString()}\t被举报=${r.account}\t由=${r.by_who}\t${r.reason}`);
    break;
  case 'stats':
    console.log(JSON.stringify({ ...store.counts(), day: dayKey() }));
    break;
  case 'mute': {
    const me = find(a), other = find(b);
    if (!me || !other) { console.error('两个账号都要存在'); process.exit(1); }
    store.mute(me.id, other.id);
    console.log(`已让 ${me.name || me.id} 静音 ${other.name || other.id}`);
    break;
  }
  case 'unmute': {
    const me = find(a), other = find(b);
    if (!me || !other) { console.error('两个账号都要存在'); process.exit(1); }
    store.unmute(me.id, other.id);
    console.log('已解除');
    break;
  }
  default:
    console.error('未知命令：' + cmd);
    process.exit(2);
}
