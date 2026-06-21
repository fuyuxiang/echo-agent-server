#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "[echo-server] 重启中..."
./stop.sh
# 强制重新构建，确保用上最新代码
rm -f dist/server.js
./start.sh
