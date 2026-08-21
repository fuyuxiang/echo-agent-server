#!/usr/bin/env bash
# ============================================================================
# Echo Agent Server - 后台停止脚本
# 流程: 读 PID 文件 -> SIGTERM 优雅退出(最多 10s) -> 超时则 SIGKILL 强杀。
# 服务不在跑时不会报错(适合部署后的反复调用)。
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

PID_FILE="run/echo-server.pid"
SERVER_ENTRY="$(pwd)/dist/server.js"

read_pid_file() {
  local pid=""
  IFS= read -r pid < "$PID_FILE" || true
  printf '%s' "$pid"
}

is_server_process() {
  local pid="$1"
  local command_line

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  # 兼容升级前以相对路径启动的旧进程；新进程统一使用绝对入口路径。
  [[ "$command_line" == *"$SERVER_ENTRY"* ]] ||
    [[ "$command_line" == *"node --env-file=.env dist/server.js"* ]]
}

if [ ! -f "$PID_FILE" ]; then
  echo "[echo-server] 未找到 PID 文件，服务可能未运行"
  echo "[echo-server] 如需启动: ./start.sh"
  exit 0
fi

PID="$(read_pid_file)"

if ! is_server_process "$PID"; then
  if [[ "$PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$PID" 2>/dev/null; then
    echo "[echo-server] PID ${PID} 属于其他进程，不会发送停止信号"
  else
    echo "[echo-server] 服务进程 ${PID:-未知} 不存在"
  fi
  echo "[echo-server] 清理无效 PID 文件"
  rm -f "$PID_FILE"
  echo "[echo-server] 如需启动: ./start.sh"
  exit 0
fi

echo "[echo-server] 停止中 (PID $PID)..."
# 先发 TERM 让进程优雅退出
kill -TERM "$PID" 2>/dev/null || true

# 最多等待 10 秒
for ((attempt = 1; attempt <= 10; attempt++)); do
  if ! is_server_process "$PID"; then
    rm -f "$PID_FILE"
    echo "[echo-server] 已停止 (PID $PID)"
    echo "[echo-server] 重新启动: ./start.sh"
    exit 0
  fi
  sleep 1
done

# 仍未退出则强制结束
echo "[echo-server] 优雅退出超时，强制结束 (kill -9)"
if is_server_process "$PID"; then
  kill -KILL "$PID" 2>/dev/null || true
fi

for ((attempt = 1; attempt <= 5; attempt++)); do
  if ! is_server_process "$PID"; then
    rm -f "$PID_FILE"
    echo "[echo-server] 已停止 (PID $PID)"
    echo "[echo-server] 重新启动: ./start.sh"
    exit 0
  fi
  sleep 1
done

echo "[echo-server] 无法结束进程 $PID，PID 文件已保留，请人工检查" >&2
exit 1
