# 公网部署 · 一键启动

服务端自带静态托管，一条命令即可同时提供**游戏页面**和**联机端点**，无需 Nginx 也能直接跑。

## 1. 最短路径（裸机 VPS）

```bash
git clone <你的仓库> anime-world && cd anime-world
bash deploy/start.sh -d          # 后台启动；首次运行会自动安装 bun
```

看到 `已在后台启动 · PID xxxx · 端口 8770` 即成功。玩家地址：

```
http://<公网IP>:8770/            打开即玩（页面与服务器同源，无需填地址）
ws://<公网IP>:8770/ws            联机端点（由页面自动使用）
```

> 云主机务必在**安全组/防火墙放行 TCP 8770 入方向**：
> `sudo ufw allow 8770/tcp` 或云控制台安全组添加入方向规则。

常用运维命令：

```bash
bash deploy/start.sh --status    # 状态 + 健康检查
bash deploy/start.sh --logs      # 跟踪日志
bash deploy/start.sh --stop      # 停止
bash deploy/start.sh --install   # 装成 systemd 服务（开机自启、崩溃自拉，需 sudo）
bash deploy/start.sh --uninstall
```

改配置：`cp deploy/.env.example deploy/.env` 后编辑，再重启。人数上限、分线数、连接限额、TLS 都在其中。

账号、进度、留言石碑、世界进度都存在同一个 SQLite 文件里。**不设 `AW_DB` 就退回内存模式**：联机照常好玩，但一重启，所有人的旅程、石碑与分线进度都清零。正式对外务必设：

```bash
sudo mkdir -p /var/lib/anime-world && sudo chown "$(whoami)" /var/lib/anime-world
# deploy/.env
AW_DB=/var/lib/anime-world/world.db    # bun:sqlite，WAL；旁边会出现 .db-wal/.db-shm
```
用 `--install` 装成 systemd 服务时注意：单元里 `ProtectHome=read-only`，**放不到 `/home` 下**；
`/var/lib/anime-world` 这类路径可写。目录打不开只会打日志并退回内存模式，不影响联机。
备份/停机请直接拷走 `world.db*` 三个文件；升级表结构不需要迁移脚本（启动时 `alter table add column` 幂等补齐）。

游客号是自动开的（玩家不点任何东西也在落库），昵称+密码是可选的「转正」。凭据走 `HttpOnly + SameSite=Lax` Cookie，前端脚本读不到。

## 1.5 管理与封禁

运维命令行直接读写同一个库（需显式带上 `AW_DB`）：

```bash
AW_DB=/var/lib/anime-world/world.db bun server/cli.js accounts 20     # 最近活动的账号
AW_DB=/var/lib/anime-world/world.db bun server/cli.js who 旅人618      # 按账号 id 或昵称查档案
AW_DB=/var/lib/anime-world/world.db bun server/cli.js reports         # 玩家举报（人工处理入口）
AW_DB=/var/lib/anime-world/world.db bun server/cli.js bans           # 当前封禁
AW_DB=/var/lib/anime-world/world.db bun server/cli.js ban 旅人618 60 "辱骂同伴"   # 封 60 分钟
AW_DB=/var/lib/anime-world/world.db bun server/cli.js unban 旅人618
AW_DB=/var/lib/anime-world/world.db bun server/cli.js mute <账号> / unmute <账号>
```

- `ban` 会同时封掉该账号**最近使用的 IP**：只封账号的话，丢掉 Cookie 换个匿名连接就回来了。
  反过来说，如果一批玩家共用出口 IP（校园/公司 NAT、走同一个反代却没设 `TRUST_PROXY=1`），封 IP 会误伤 —— 这种情况下先修 `TRUST_PROXY`，或缩短封禁时长。
- 匿名连接（没 Cookie）永远允许进房，只是不落库、不能被静音/举报追责。
- 静音是玩家自助的、跟着账号走：只挡说话/动作/呼叫/留言，不抹掉对方在世界里的存在。
- 登录保护按 **IP** 计数（连错 5 次锁 10 分钟），不是按账号 —— 所以攻击者换 IP 就能绕；这是原型级的取舍，正式运营要加验证码与账号级限速。**没有密码找回**：玩家忘了密码只能靠你手动改库。
- 没上 TLS 时 Cookie 不是 `Secure`，凭据会明文过网 —— 正式对外前请做完下面第 3 节。

## 2. 容器部署

```bash
cd deploy
docker compose up -d --build
docker compose logs -f
```

## 3. 域名 + HTTPS（推荐正式对外时使用）

浏览器以 `https://` 打开页面时，**只允许连 `wss://`**，所以要么给服务端挂证书，要么前置反代。

**方式 A · Caddy（自动签发续期，最少配置）**

```caddy
game.example.com {
    reverse_proxy 127.0.0.1:8770
}
```

**方式 B · Nginx**：见 `deploy/proxy.example.txt`（含 WebSocket 升级与长连接超时设置）。

**方式 C · 服务端自己挂证书**：在 `deploy/.env` 里设

```
TLS_CERT=/etc/letsencrypt/live/game.example.com/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/game.example.com/privkey.pem
```

用 A/B 时请把 `TRUST_PROXY=1` 写入 `deploy/.env`，服务端才按 `X-Forwarded-For` 统计真实 IP（否则所有连接都被算作 127.0.0.1，会一起受单 IP 限额约束）。

## 4. 玩家侧的连接方式

| 场景 | 做法 |
|---|---|
| 从服务器域名/IP 打开页面 | 什么都不用填，点「连线同行」即可（同源 `/ws`） |
| 本地 `index.html` 连远程服 | 标题页「服务器地址」填 `ws://IP:8770` 或 `wss://game.example.com`，只需填一次 |
| 快速分享链接 | `http://<IP>:8770/?srv=ws://<IP>:8770/ws` |

## 5. 公网加固（已内置）

| 项 | 默认 | 说明 |
|---|---|---|
| 全局在连数 | 512 | 超限返回 `503 + Retry-After`，握手都不做 |
| 单 IP 在连数 | 8 | 挡住单机脚本刷房 |
| 单帧上限 | 2048 B | 超限直接 `close(1009)` |
| 消息速率 | 60 条/秒 · 令牌桶 | 超限拉黑 30s；15Hz 正常流量绝不会触发 |
| 未握手连接回收 | 15s | 只连不发包的占坑连接自动踢掉 |
| 重连槽位 TTL | 30s | `pending` 表按期清理，不累积 |
| 重复握手 | 忽略 | 同一条 socket 反复 `hello` 不再产生新玩家 |
| 页面压缩 | gzip + ETag | `index.html` 909 KB → 248 KB，二次访问 304 |
| 进程管理 | systemd `Restart=always` | 崩溃自拉、开机自启 |
| 账号接口 | 只吃 `application/json` · 请求体 ≤8KB | 跨站表单发不出这个 content-type，等于一道廉价的 CSRF 门；解析失败一律回 `bad_request` 不透细节 |
| 密码与会话 | scrypt + salt · 令牌只存 sha256 | 库里拿不到明文；昵称先过白名单再入库 |
| 登录/开号节流 | 同 IP 连错 5 次锁 10 分钟；开号 30/分钟、绑定 10/分钟 | 挡住脚本撞库与批量注册 |
| 权威写入闸门 | 任务只认 `+1`；王单跳封顶 `KING_HIT`、0.2s 一跳；潮池单跳封顶 `TIDE_HIT`、0.2s 一跳且两人以上才开波；碎片须在场 12u 内、0.4s 一跳 | 改本地内存秒杀/秒捡/跳剧情都会被拒绝并计入 `/metrics`；星屑弹（`bo`）与烟花（`fw`）只是演出，服务端不带伤害字段 |

## 6. 故障排查

```bash
curl http://127.0.0.1:8770/healthz   # 服务本体是否活着（在线/在连/TLS/库模式 db 与账号计数）
curl http://127.0.0.1:8770/rooms     # 各分线与成员，排查“看不见彼此”先看是否同线
curl http://127.0.0.1:8770/metrics   # 丢弃与各类拒绝计数，判断是否被限额或权威闸门挡住
journalctl -u anime-world -f         # systemd 模式日志
```

- **点连线一直「重连中」**：端口未放行，或 https 页面配了 `ws://`（需 `wss://`）。
- **两人互相看不见 / 对方一直站在原地**：先确认 `j:true` 且在**同一条分线**（`/rooms` 按 lane 分组）。再看 `/metrics` 的 `drops` 与 `resync`、`/rooms` 里各成员的 `rej`：`rej` 长期偏高说明该客户端的位置帧一直被判超速（网络抖动、跨端时间差、改了移动速度）；正常情况下 1.2 秒内的自动重同步会纠正，`resync` 缓慢增长是健康现象。
- **前端与服务端版本不一致**：协议加了字段（`pr`、`km`、`ws` 的 `we/tr/ta/th/tm`、`bo`/`th`/`td`、`welcome.me/prog/world/shards`）却没换 `index.html`，表现为功能静默失灵——`index.html` 与 `server/`（`index.js`+`db.js`+`auth.js`+`cli.js`+`weather.js`）必须一起上传再重启。少传 `weather.js` 服务直接起不来（`import` 找不到模块），日志里那一行很好认；旧前端只是打不到潮、看不见同伴的星屑弹、也听不见天气的口播，不会把世界打坏。
- **有人反映「动不了」**：看 `/metrics` 的 `drops`；若持续增长说明该客户端帧异常，检查是否被 `ban`（`/rooms` 有 `ban` 字段，`cli.js bans` 看清单）。
- **有人刻不上留言**：服务端会**静默拒绝**违规留言（离自己超过 14 米、与别人的石碑重叠不足 3.6 米、8 秒内重刻、文本被过滤后为空、本线已满 40 块）。客户端在 1.2 秒内没收到回灌会提示「旁边太挤或刚刻过」。跨重启留存见上面 `AW_DB`。
- **玩家说进度没了**：`/healthz` 的 `db` 是 `memory` 就是没设 `AW_DB`（或目录不可写，日志里有一行 `[db] 无法打开…`）。另一种是他换了设备却没绑定昵称密码——游客号只认这台设备的 Cookie。
- **任务/王血不推进**：`/metrics` 的 `world_rejected`、`king_rejected`、`take_rejected` 涨得很快，说明有客户端在提交非法进度（改存档或前端版本过旧）。
- **成长与图鉴的账**：`gear_rejected`（买不起或不存在的升级线）、`codex_rejected`（非法/重复的打卡键）、`firework_rejected`（八秒内连点烟花）只说明「被闸门挡下」，不是故障。有人反映练了没生效，先 `cli.js who` 看档案里的 `gem/gear`——多半是他其实没有身份：匿名玩家的成长只记在自己那台设备上。
- **「打不动史莱姆潮」**：`tide_rejected` 涨只意味着有人往一个已经空了的池子里投伤害（或者前端比服务端旧）。波本身是服务端自己开的：**这条分线里至少要有两个已进房的人**，而且距上一波得满 `TIDE_MS`；一个人单站的分线永远不起潮。`/metrics` 的 `tides` 是当前正在打的分支数；已压下的波次记在库里（`world.tide_round`），重启会把没打完的池子散掉，但不会忘掉谁的功劳。
- **同伴看不见我的星屑弹**：`bolt_rejected` 是 0.35s 内的连点被限流；真的一个都没出现，多半是他那份 `index.html` 旧（弹的伤害本来就不经服务端，服务端只转发演出）。
- **想换端口**：`deploy/.env` 改 `PORT=`，注意同步安全组与玩家地址。
- **想调难度与天气**：`KING_HP`（每条分线王的血量，默认 60）、`KING_HIT`（单跳封顶，默认 8）、`MAX_SHARDS`（每线碎片记录上限，默认 60）、`WEATHER_MS`（每条分线多久换一次天气，默认 240000；玩家端没有改天气的入口，只有「要不要看」的开关）、`WEATHER_PIN`（把天气钉死成 `clear`/`petal`/`rain`/`fog`/`meteor` 之一，演示服或拍宣传片用；钉住后这一种也会随快照落进库，玩家依然在小道具上感到它的效果）、`TIDE_MS`/`TIDE_HP`/`TIDE_HIT`/`TIDE_GEM`（史莱姆潮的间隔/池子基数/单跳进池封顶/每波每人奖励，默认 150000/40/8/5——嫌波太绵就调小 `TIDE_MS` 或调大 `TIDE_HP`，想让星尘更金贵就调小 `TIDE_GEM`）。

## 7. 回归测试

```bash
bun test/run-all.mjs          # 七个套件并发跑，约 14 秒
bun test/run-all.mjs account  # 只跑其中某个（可传多个关键字）
```
覆盖协议与 Guard、真实联网层、公网加固边界、账号与权威（含重启留存与 CLI 封禁）、库/鉴权纯逻辑、界面静态接线，以及 headless Chrome 的真实点击流程（无 Chrome 时自动跳过）。测试服务端一律 `PORT=0` 由系统挑端口，避免被上一轮遗留进程冒充。
