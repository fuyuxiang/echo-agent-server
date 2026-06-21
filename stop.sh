#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PID_FILE="run/echo-server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "[echo-server] 未找到 PID 文件，服务可能未运行"
  exit 0
fi

PID="$(cat "$PID_FILE")"

if ! kill -0 "$PID" 2>/dev/null; then
  echo "[echo-server] 进程 $PID 不存在，清理 PID 文件"
  rm -f "$PID_FILE"
  exit 0
fi

echo "[echo-server] 停止中 (PID $PID)..."
# 先发 TERM 让进程优雅退出
kill "$PID"

# 最多等待 10 秒
for _ in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "[echo-server] 已停止"
    exit 0
  fi
  sleep 1
done

# 仍未退出则强制结束
echo "[echo-server] 优雅退出超时，强制结束 (kill -9)"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "[echo-server] 已停止"
