#!/usr/bin/env bash
# ============================================================================
# Echo Agent Server - 一键重启脚本
# 流程: 先构建验证 -> ./stop.sh -> ./start.sh
# 构建失败时保留当前服务继续运行，避免因为代码或依赖问题造成不必要的停机。
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

echo "[echo-server] 重启中..."
# 先完成依赖与构建检查；只有新版本可构建时才停止旧服务。
if [ ! -f .env ]; then
  echo "[echo-server] 缺少 .env 文件，保留当前服务不变" >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "[echo-server] 安装依赖..."
  npm install
fi
echo "[echo-server] 构建中 (npm run build)..."
npm run build
echo "[echo-server] 校验配置..."
node --env-file=.env -e \
  'import("./dist/config.js").then(({ loadConfig }) => loadConfig()).catch((error) => { console.error("[echo-server] " + error.message); process.exit(1) })'

./stop.sh
./start.sh
