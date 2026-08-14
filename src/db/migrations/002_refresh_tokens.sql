-- refresh token 存储。
--
-- 只存 sha256 哈希:库泄露时明文 refresh token 等同于长期有效的密码。
-- 一次性使用(consume 即删),重放因查不到记录而失败。

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id, device_id);
CREATE INDEX idx_refresh_expiry ON refresh_tokens(expires_at);
