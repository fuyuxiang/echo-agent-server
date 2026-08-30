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

# 把 .env 注入当前 shell，供随后启动的 node 进程使用；兼容 Node 16（不支持 --env-file）。
# set -a 会让后续 source/sourced 的赋值自动 export。
load_dotenv() {
  # 去除行尾空白与回车，跳过空行与 # 注释
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # 仅处理 KEY=VALUE 形式；已有引号的也保留
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      export "$key=$value"
    fi
  done < .env
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
if [ ! -d web/node_modules ]; then
  echo "[echo-server] 安装管理后台依赖..."
  npm --prefix web install
fi

# 每次启动都构建，避免 git pull 后继续运行过期 dist/web/dist。
# restart.sh 已在停服前构建过，会用 ECHO_SKIP_BUILD=1 避免重复构建。
if [ "${ECHO_SKIP_BUILD:-0}" != "1" ]; then
  echo "[echo-server] 构建服务端与管理后台 (npm run build:all)..."
  npm run build:all
fi

# 把 .env 注入当前 shell。兼容 Node 16（无 --env-file）与未来高版本；
# bash 直接 source 也可以，但这里手工解析能跳过注释行并保留已有 shell 变量优先级。
load_dotenv
# shellcheck disable=SC2154
# shellcheck disable=SC2034
PORT="${ECHO_PORT:-8787}"
HOST="${ECHO_HOST:-0.0.0.0}"
ADMIN_USER="${ECHO_ADMIN_USER:-admin}"
DB_PATH="${ECHO_DB_PATH:-./data/echo.db}"

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
# 环境变量已通过 load_dotenv 注入当前 shell；后台运行，日志重定向到文件。
nohup node "$SERVER_ENTRY" >> "$LOG_FILE" 2>&1 &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"

# 写一个临时探测脚本：兼容 Node 16（无全局 fetch），用 http/https 模块探测 /api/v1/health。
HEALTH_PROBE="$(mktemp -t echo-health.XXXXXX.js)"
cat > "$HEALTH_PROBE" <<'PROBE_EOF'
// process.argv: [0]=node, [1]=脚本路径, [2]=要探测的 URL
const url = new URL(process.argv[2]);
const lib = url.protocol === 'https:' ? require('https') : require('http');
const req = lib.request(url, { method: 'GET', timeout: 1000 }, (res) => {
  // 启动期的健康检查只要端口上有人在应答 HTTP 即可；4xx 也算就绪。
  process.exit(res.statusCode >= 200 && res.statusCode < 500 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(new Error('timeout')); process.exit(1); });
req.end();
PROBE_EOF
trap 'rm -f "$HEALTH_PROBE"' EXIT

# 最多等待 30 秒，以公开健康接口成功响应作为启动完成标准。
READY=false
for ((attempt = 1; attempt <= 30; attempt++)); do
  if ! is_server_process "$PID"; then
    break
  fi
  if node "$HEALTH_PROBE" "$HEALTH_URL"; then
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
