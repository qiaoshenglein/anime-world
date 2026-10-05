#!/usr/bin/env bash
# 星屑物语 · 多人联机服务端 一键启动脚本（Linux / macOS）
#   bash deploy/start.sh              前台启动（Ctrl+C 停止）
#   bash deploy/start.sh -d           后台启动（日志 deploy/anime-world.log，PID 见 .pid）
#   bash deploy/start.sh --stop       停止后台实例
#   bash deploy/start.sh --status     查看运行状态
#   bash deploy/start.sh --logs       跟踪日志
#   bash deploy/start.sh --install    安装为 systemd 服务（开机自启、崩溃自拉）
#   bash deploy/start.sh --uninstall  卸载 systemd 服务
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
CONF="$DIR/deploy/.env"
LOG="$DIR/deploy/anime-world.log"
PIDF="$DIR/deploy/anime-world.pid"

# ---- 读取配置（deploy/.env 可覆盖）
if [ -f "$CONF" ]; then set -a; . "$CONF"; set +a; fi
export PORT="${PORT:-8770}" HOST="${HOST:-0.0.0.0}"
[ -n "${TLS_CERT:-}" ] && export TLS_CERT TLS_KEY
[ -n "${MAX_PLAYERS:-}" ] && export MAX_PLAYERS LANES
[ -n "${TRUST_PROXY:-}" ] && export TRUST_PROXY
[ -n "${QUIET:-}" ] && export QUIET

# ---- 确保 bun 存在
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "未检测到 bun，正在安装（官方脚本，需要 curl 与 git）…"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null 2>&1 || { echo "bun 安装失败，请手动安装后重试：https://bun.sh"; exit 1; }
  fi
fi

port_pid() {
  if command -v ss >/dev/null 2>&1; then ss -lptn "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
  elif command -v lsof >/dev/null 2>&1; then lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
  fi
}

case "${1:-run}" in
  -d|--daemon)
    OLD="$(port_pid || true)"
    [ -n "$OLD" ] && { echo "端口 $PORT 已被进程 $OLD 占用，先执行 bash deploy/start.sh --stop"; exit 1; }
    nohup bun server/index.js >>"$LOG" 2>&1 &
    echo $! >"$PIDF"
    sleep 1
    if kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      echo "已在后台启动 · PID $(cat "$PIDF") · 端口 $PORT"
      echo "玩家入口  http://<公网IP>:$PORT/    联机端点  ws://<公网IP>:$PORT/ws"
      echo "健康检查  curl http://127.0.0.1:$PORT/healthz     日志  bash deploy/start.sh --logs"
      echo "提示：若防火墙/安全组未放行 $PORT，请自行开放（云主机需在安全组添加入方向 TCP）。"
    else
      echo "启动失败，最近日志："; tail -20 "$LOG" || true; exit 1
    fi
    ;;
  --stop)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      kill "$(cat "$PIDF")"; rm -f "$PIDF"; echo "已停止"
    else
      P="$(port_pid || true)"
      [ -n "$P" ] && { kill "$P"; echo "已停止占用 $PORT 的进程 $P"; } || echo "没有在运行的实例"
    fi
    ;;
  --status)
    P="$(port_pid || true)"
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "运行中 · PID $(cat "$PIDF") · 端口 $PORT"
    elif [ -n "$P" ]; then echo "运行中（非本脚本启动）· PID $P · 端口 $PORT"
    else echo "未运行"; fi
    curl -s --max-time 3 "http://127.0.0.1:$PORT/healthz" || echo "（健康检查无响应）"
    ;;
  --logs)
    [ -f "$LOG" ] || { echo "尚无日志文件"; exit 0; }
    tail -n 60 -f "$LOG"
    ;;
  --install)
    [ "$(id -u)" = 0 ] || { echo "安装 systemd 服务需要 root：sudo bash deploy/start.sh --install"; exit 1; }
    command -v systemctl >/dev/null || { echo "此系统没有 systemd，请改用 --daemon 或 Docker"; exit 1; }
    BUN_PATH="$(command -v bun)"
    sed -e "s|__DIR__|$DIR|g" -e "s|__USER__|$(whoami)|g" -e "s|__BUN__|$BUN_PATH|g" "$DIR/deploy/anime-world.service" >/etc/systemd/system/anime-world.service
    systemctl daemon-reload
    systemctl enable --now anime-world
    sleep 1
    systemctl --no-pager --lines=8 status anime-world || true
    echo "服务已安装：systemctl {status|restart|stop} anime-world ；日志 journalctl -u anime-world -f"
    ;;
  --uninstall)
    [ "$(id -u)" = 0 ] || { echo "需要 root：sudo bash deploy/start.sh --uninstall"; exit 1; }
    systemctl disable --now anime-world 2>/dev/null || true
    rm -f /etc/systemd/system/anime-world.service
    systemctl daemon-reload
    echo "已卸载 systemd 服务"
    ;;
  run|"")
    echo "前台启动（Ctrl+C 停止）· 端口 $PORT · 后台运行请用 bash deploy/start.sh -d"
    exec bun server/index.js
    ;;
  *)
    echo "用法: bash deploy/start.sh [-d|--stop|--status|--logs|--install|--uninstall]"; exit 1;;
esac
