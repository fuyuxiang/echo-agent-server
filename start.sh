#!/usr/bin/env bash
# ============================================================================
# Echo Agent Server - 后台启动脚本
# 流程: 依赖检查 -> 构建产物检查 -> nohup 启动 -> 存活校验 -> 打印访问信息
# 同进程已在跑则直接提示并退出(不重复启动)。如需重启请用 ./restart.sh。
# ============================================================================
set -euo pipefail

# 切到脚本所在目录，保证相对路径稳定
cd "$(dirname "$0")"

PID_FILE="run/echo-server.pid"
LOG_FILE="logs/echo-server.log"
SERVER_ENTRY="$(pwd)/dist/server.js"

mkdir -p run logs

read_pid_file() {
  local pid=""
  IFS= read -r pid < "$PID_FILE" || true
  printf '%s' "$pid"
}

# PID 存活且命令行确实是本仓库的服务进程时才算有效，避免 PID 被复用后误判。
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

# 已在运行则不重复启动
if [ -f "$PID_FILE" ]; then
  PID="$(read_pid_file)"
  if is_server_process "$PID"; then
    echo "[echo-server] 已在运行 (PID ${PID})，如需重启请用 ./restart.sh"
    exit 0
  fi
  echo "[echo-server] 清理无效 PID 文件 (${PID:-空})"
  rm -f "$PID_FILE"
fi

# 必须有 .env(ECHO_JWT_SECRET / ECHO_MASTER_KEY 等靠它注入,缺失时启动即失败)
if [ ! -f .env ]; then
  echo "[echo-server] 缺少 .env 文件，请先按 .env.example 创建并设置 ECHO_JWT_SECRET(>=32 字符)" >&2
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

# 使用与服务启动完全相同的 Node .env 解析规则，兼容引号、空格与系统环境变量覆盖。
read_env() {
  node --env-file=.env -e \
    'const [key, fallback] = process.argv.slice(1); process.stdout.write(process.env[key] || fallback)' \
    "$1" "$2"
}

PORT="$(read_env ECHO_PORT 8787)"
HOST="$(read_env ECHO_HOST 0.0.0.0)"
ADMIN_USER="$(read_env ECHO_ADMIN_USER admin)"
DB_PATH="$(read_env ECHO_DB_PATH ./data/echo.db)"

# 监听所有网卡时使用回环地址做本机访问和就绪探测；IPv6 地址需要方括号。
case "$HOST" in
  0.0.0.0|::) ACCESS_HOST="127.0.0.1" ;;
  *) ACCESS_HOST="$HOST" ;;
esac
if [[ "$ACCESS_HOST" == *:* && "$ACCESS_HOST" != \[*\] ]]; then
  URL_HOST="[${ACCESS_HOST}]"
else
  URL_HOST="$ACCESS_HOST"
fi
BASE_URL="http://${URL_HOST}:${PORT}"
HEALTH_URL="${BASE_URL}/api/v1/health"

if [[ "$DB_PATH" == :memory:* ]]; then
  DISPLAY_DB_PATH="$DB_PATH"
else
  DISPLAY_DB_PATH="$(node -e 'const path = require("path"); process.stdout.write(path.resolve(process.argv[1]))' "$DB_PATH")"
fi

echo "[echo-server] 启动中..."
# 用 Node 原生 --env-file 加载 .env，后台运行，日志重定向到文件
nohup node --env-file=.env "$SERVER_ENTRY" >> "$LOG_FILE" 2>&1 &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"

# 最多等待 30 秒，以公开健康接口成功响应作为启动完成标准。
READY=false
for ((attempt = 1; attempt <= 30; attempt++)); do
  if ! is_server_process "$PID"; then
    break
  fi
  if node -e \
    'fetch(process.argv[1], { signal: AbortSignal.timeout(1000) }).then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))' \
    "$HEALTH_URL"; then
    # 防止端口上已有其他健康服务：等待本次子进程稳定后再确认成功。
    sleep 1
    if is_server_process "$PID"; then
      READY=true
      break
    fi
  fi
  sleep 1
done

if [ "$READY" = true ]; then
  cat <<EOF
[echo-server] 已启动 (PID ${PID})

  📍 访问地址
    管理后台:   ${BASE_URL}/
    API 根:     ${BASE_URL}/api/v1
    健康检查:   ${HEALTH_URL}

  🔑 初始管理员配置
    用户名:     ${ADMIN_USER}
    密码:       .env 中 ECHO_ADMIN_PASSWORD（仅首次初始化数据库时使用）

  📂 文件位置
    PID:        ${PID_FILE}
    日志:       ${LOG_FILE}
    数据库:     ${DISPLAY_DB_PATH}

  🛠  常用命令
    停止:       ./stop.sh
    重启:       ./restart.sh
    实时日志:   tail -f ${LOG_FILE}
EOF
else
  if is_server_process "$PID"; then
    ./stop.sh || true
  else
    rm -f "$PID_FILE"
  fi
  echo "[echo-server] 启动失败或健康检查在 30 秒内未就绪，请查看日志: $LOG_FILE" >&2
  echo "[echo-server] 常见原因: 配置校验失败(检查 .env 中 ECHO_JWT_SECRET / ECHO_MASTER_KEY)、端口被占用" >&2
  exit 1
fi
