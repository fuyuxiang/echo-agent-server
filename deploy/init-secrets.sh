#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
SECRET_DIR="deploy/secrets"
mkdir -p "$SECRET_DIR"
umask 077

random_secret() {
  node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))"
}

write_secret_if_empty() {
  local name="$1"
  local value="$2"
  if [ -s "$SECRET_DIR/$name" ]; then
    echo "保留已有 secret: $name"
    return
  fi
  printf '%s' "$value" > "$SECRET_DIR/$name"
  chmod 600 "$SECRET_DIR/$name"
}

if [ ! -s "$SECRET_DIR/echo_admin_password" ]; then
  if [ -z "${ECHO_BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
    echo "请通过 ECHO_BOOTSTRAP_ADMIN_PASSWORD 提供首次管理员密码（至少 8 位）" >&2
    exit 1
  fi
  if [ "${#ECHO_BOOTSTRAP_ADMIN_PASSWORD}" -lt 8 ]; then
    echo "ECHO_BOOTSTRAP_ADMIN_PASSWORD 至少 8 位" >&2
    exit 1
  fi
fi

# JWT 与主密钥一旦用于现有数据库就不能被初始化脚本静默轮换。
write_secret_if_empty echo_jwt_secret "$(random_secret)"
write_secret_if_empty echo_master_key "$(random_secret)"
write_secret_if_empty echo_admin_password "${ECHO_BOOTSTRAP_ADMIN_PASSWORD:-}"
write_secret_if_empty echo_chat_key "${ECHO_CHAT_KEY:-}"
write_secret_if_empty echo_embed_key "${ECHO_EMBED_KEY:-}"
write_secret_if_empty echo_rerank_key "${ECHO_RERANK_KEY:-}"
write_secret_if_empty echo_ocr_key "${ECHO_OCR_KEY:-}"
write_secret_if_empty echo_vlm_key "${ECHO_VLM_KEY:-}"
write_secret_if_empty echo_transcribe_key "${ECHO_TRANSCRIBE_KEY:-}"

echo "已创建 deploy/secrets/（权限 600）。空的模型密钥必须在上线前填写。"
