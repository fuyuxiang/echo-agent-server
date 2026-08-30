#!/usr/bin/env bash
# eval/ci.sh —— CI 用的端到端评估脚本。
#
# 行为:
#   1. 在隔离端口启动一个 build 过的 server;
#   2. 等待 health;
#   3. 跑 npm run eval;
#   4. 把 server 杀掉;
#   5. 把 eval 退出码透传给 CI,失败即阻断。
#
# 用法:
#   bash eval/ci.sh
#
# 需要的环境变量(在 CI 配置):
#   ECHO_JWT_SECRET            至少 32 字节随机串
#   ECHO_MASTER_KEY            任意非空随机串
#   ECHO_ADMIN_USER            初始管理员用户名
#   ECHO_ADMIN_PASSWORD        初始管理员密码(>= 8 位)
#   ECHO_EVAL_USERS            "user1:pwd1,user2:pwd2" —— 用于权限用例
#
# 可选:
#   ECHO_EVAL_JUDGE_URL        LLM judge 服务 URL
#   ECHO_EVAL_JUDGE_MODEL      judge 模型名

set -euo pipefail

PORT="${ECHO_EVAL_PORT:-8789}"
LOGFILE="${ECHO_EVAL_LOG:-/tmp/echo-eval-server.log}"
PIDFILE="/tmp/echo-eval-server.pid"
DB_PATH="/tmp/echo-eval-$$-db"
STORAGE_PATH="/tmp/echo-eval-$$-storage"

cleanup() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # 只清理由本次脚本按固定安全前缀创建的隔离数据。
  if [[ "$DB_PATH" == /tmp/echo-eval-*-db ]]; then
    rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
  fi
  if [[ "$STORAGE_PATH" == /tmp/echo-eval-*-storage ]]; then
    rm -rf "$STORAGE_PATH"
  fi
}
trap cleanup EXIT

if [[ -z "${ECHO_JWT_SECRET:-}" ]] || [[ -z "${ECHO_MASTER_KEY:-}" ]] || \
   [[ -z "${ECHO_ADMIN_USER:-}" ]] || [[ -z "${ECHO_ADMIN_PASSWORD:-}" ]]; then
  echo "[eval:ci] 缺少必要的 ECHO_JWT_SECRET / ECHO_MASTER_KEY / ECHO_ADMIN_USER / ECHO_ADMIN_PASSWORD" >&2
  exit 2
fi

echo "[eval:ci] 构建..."
npm run build >/dev/null

echo "[eval:ci] 启动 server (port=$PORT, log=$LOGFILE)..."
ECHO_PORT="$PORT" \
ECHO_DB_PATH="$DB_PATH" \
ECHO_STORAGE_DIR="$STORAGE_PATH" \
ECHO_DISABLE_LOGIN_THROTTLE=1 \
node dist/server.js >"$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

# 等待 health
for i in {1..40}; do
  if curl -sf "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null; then
    echo "[eval:ci] server ready"
    break
  fi
  sleep 0.5
  if [[ $i -eq 40 ]]; then
    echo "[eval:ci] server 启动超时,请查看 $LOGFILE" >&2
    tail -50 "$LOGFILE" >&2 || true
    exit 3
  fi
done

echo "[eval:ci] 灌 fixture 库..."
ECHO_DB_PATH="$DB_PATH" \
  npx tsx eval/fixture.ts

echo "[eval:ci] 跑评估..."
ECHO_EVAL_BASE_URL="http://127.0.0.1:${PORT}" \
ECHO_EVAL_USERS="${ECHO_EVAL_USERS:-}" \
ECHO_ADMIN_PASSWORD="$ECHO_ADMIN_PASSWORD" \
npm run eval
rc=$?

echo "[eval:ci] 退出码=$rc"
exit $rc
