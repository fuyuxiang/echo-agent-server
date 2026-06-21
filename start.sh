#!/usr/bin/env bash
set -euo pipefail

# 切到脚本所在目录，保证相对路径稳定
cd "$(dirname "$0")"

PID_FILE="run/echo-server.pid"
LOG_FILE="logs/echo-server.log"

mkdir -p run logs

# 已在运行则不重复启动
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[echo-server] 已在运行 (PID $(cat "$PID_FILE"))，如需重启请用 ./restart.sh"
  exit 0
fi
# 残留的失效 PID 文件清理掉
[ -f "$PID_FILE" ] && rm -f "$PID_FILE"

# 必须有 .env（ECHO_SERVER_SECRET 等靠它注入）
if [ ! -f .env ]; then
  echo "[echo-server] 缺少 .env 文件，请先创建并设置 ECHO_SERVER_SECRET（>=32 字节）" >&2
  exit 1
fi

# 安装依赖（仅当 node_modules 缺失时）
if [ ! -d node_modules ]; then
  echo "[echo-server] 安装依赖..."
  npm install
fi

# 构建产物缺失则编译
if [ ! -f dist/server.js ]; then
  echo "[echo-server] 构建中 (npm run build)..."
  npm run build
fi

echo "[echo-server] 启动中..."
# 用 Node 原生 --env-file 加载 .env，后台运行，日志重定向到文件
nohup node --env-file=.env dist/server.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# 稍等片刻确认进程没有立刻退出
sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[echo-server] 已启动 (PID $(cat "$PID_FILE"))，日志: $LOG_FILE"
else
  echo "[echo-server] 启动失败，请查看日志: $LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
fi
