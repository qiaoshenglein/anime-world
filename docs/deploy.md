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
| 页面压缩 | gzip + ETag | `index.html` 887 KB → 243 KB，二次访问 304 |
| 进程管理 | systemd `Restart=always` | 崩溃自拉、开机自启 |

## 6. 故障排查

```bash
curl http://127.0.0.1:8770/healthz   # 服务本体是否活着（含在线数、在连数、TLS 状态）
curl http://127.0.0.1:8770/rooms     # 各分线与成员，排查“看不见彼此”先看是否同线
curl http://127.0.0.1:8770/metrics   # 丢弃/拒绝计数，判断是否被限额挡住
journalctl -u anime-world -f         # systemd 模式日志
```

- **点连线一直「重连中」**：端口未放行，或 https 页面配了 `ws://`（需 `wss://`）。
- **两人互相看不见**：确认在不同浏览器窗口都真连上了（`/rooms` 里应看到两条同名/异名成员且 `j:true`）。
- **有人反映「动不了」**：看 `/metrics` 的 `drops`；若持续增长说明该客户端帧异常，检查是否被 `ban`（`/rooms` 有 `ban` 字段）。
- **想换端口**：`deploy/.env` 改 `PORT=`，注意同步安全组与玩家地址。

## 7. 下一步（P2 计划）

共享任务链与史莱姆王世界 Boss 走服务端权威（血量、击杀事件、许愿次数），并把房间进度落盘 `server/rooms.json`，重启后世界进度不丢。当前版本的世界进度仍按客户端本地推进，只有玩家在房间内的实时状态是同步的。
