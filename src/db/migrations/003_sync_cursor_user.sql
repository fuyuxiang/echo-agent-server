-- 同步游标改为 (user_id, device_id) 复合主键。
--
-- 旧主键只有 device_id,导致同一台设备在不同用户之间切换时,后登录的用户
-- 的游标会覆盖前一个用户的进度,前一个用户的离线缓存永远停在被覆盖点。
-- 改为复合键后,每个用户在自己的每台设备上独立维护水位。
--
-- 迁移步骤:
--   1. 用旧主键对应的多行迁移到临时表,合并同一对 (user_id, device_id)
--      时保留最新水位;
--   2. 删除旧 sync_cursors;
--   3. 重建带新主键的表;
--   4. 写入合并结果。

CREATE TABLE _sync_cursor_tmp (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  cursor    INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER,
  PRIMARY KEY (user_id, device_id)
);

INSERT INTO _sync_cursor_tmp (user_id, device_id, cursor, synced_at)
SELECT user_id,
       device_id,
       MAX(cursor) AS cursor,
       MAX(synced_at) AS synced_at
  FROM sync_cursors
 GROUP BY user_id, device_id;

DROP TABLE sync_cursors;

CREATE TABLE sync_cursors (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  cursor    INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER,
  PRIMARY KEY (user_id, device_id)
);

INSERT INTO sync_cursors (user_id, device_id, cursor, synced_at)
SELECT user_id, device_id, cursor, synced_at FROM _sync_cursor_tmp;

DROP TABLE _sync_cursor_tmp;
