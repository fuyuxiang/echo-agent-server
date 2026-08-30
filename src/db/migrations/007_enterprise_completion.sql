-- 企业纵向闭环补完：扫描报告、发布分区、Skill 偏好/使用事件、
-- 可签名的企业策略以及组织记忆 FTS。保留旧 state 值，用 scan_status
-- 单独表达技术扫描阶段，使现有数据可无损升级。

ALTER TABLE document_submissions ADD COLUMN source_document_id TEXT
  REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE document_submissions ADD COLUMN quarantine_storage_key TEXT;
ALTER TABLE document_submissions ADD COLUMN published_storage_key TEXT;
ALTER TABLE document_submissions ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'passed'
  CHECK (scan_status IN ('queued','scanning','passed','failed'));
ALTER TABLE document_submissions ADD COLUMN scan_report_json TEXT;
ALTER TABLE document_submissions ADD COLUMN scan_started_at INTEGER;
ALTER TABLE document_submissions ADD COLUMN scan_completed_at INTEGER;

UPDATE document_submissions
   SET quarantine_storage_key = CASE WHEN result_document_id IS NULL THEN storage_key ELSE NULL END,
       published_storage_key  = CASE WHEN result_document_id IS NOT NULL THEN storage_key ELSE NULL END,
       scan_report_json       = json_object(
         'version', 1, 'status', 'passed', 'legacy', json('true'),
         'findings', json('[]'))
 WHERE scan_report_json IS NULL;

CREATE INDEX idx_doc_submission_scan
  ON document_submissions(scan_status, state, created_at);

ALTER TABLE skill_versions ADD COLUMN quarantine_package_key TEXT;
ALTER TABLE skill_versions ADD COLUMN published_package_key TEXT;
ALTER TABLE skill_versions ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'passed'
  CHECK (scan_status IN ('queued','scanning','passed','failed'));
ALTER TABLE skill_versions ADD COLUMN scan_report_json TEXT;
ALTER TABLE skill_versions ADD COLUMN changelog TEXT;
ALTER TABLE skill_versions ADD COLUMN scan_started_at INTEGER;
ALTER TABLE skill_versions ADD COLUMN scan_completed_at INTEGER;

UPDATE skill_versions
   SET quarantine_package_key = CASE WHEN state = 'pending' THEN package_key ELSE NULL END,
       published_package_key  = CASE WHEN state = 'approved' THEN package_key ELSE NULL END,
       scan_report_json       = json_object(
         'version', 1, 'status', 'passed', 'legacy', json('true'),
         'findings', json('[]'))
 WHERE scan_report_json IS NULL;

CREATE TABLE skill_user_preferences (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id   TEXT NOT NULL REFERENCES skill_families(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, skill_id)
);

CREATE TABLE skill_usage_events (
  id          TEXT PRIMARY KEY,
  skill_id    TEXT NOT NULL REFERENCES skill_families(id) ON DELETE CASCADE,
  version_id  TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  TEXT,
  result      TEXT NOT NULL CHECK (result IN ('success','failed','cancelled')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_skill_usage_quality
  ON skill_usage_events(skill_id, version_id, created_at);

CREATE TABLE enterprise_policy (
  id                      TEXT PRIMARY KEY CHECK (id = 'default'),
  version                 INTEGER NOT NULL,
  allow_local_knowledge   INTEGER NOT NULL CHECK (allow_local_knowledge IN (0,1)),
  allow_personal_cloud    INTEGER NOT NULL CHECK (allow_personal_cloud IN (0,1)),
  allow_skill_submission  INTEGER NOT NULL CHECK (allow_skill_submission IN (0,1)),
  offline_enterprise      INTEGER NOT NULL CHECK (offline_enterprise IN (0,1)),
  managed_lease_hours     INTEGER NOT NULL CHECK (managed_lease_hours BETWEEN 1 AND 168),
  updated_by              TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at              INTEGER NOT NULL
);
INSERT INTO enterprise_policy
  (id, version, allow_local_knowledge, allow_personal_cloud,
   allow_skill_submission, offline_enterprise, managed_lease_hours, updated_at)
VALUES ('default', 1, 1, 1, 1, 0, 24, 0);

-- FTS5 使记忆检索与文档 chunk 一样具备文本相关性，不再使用
-- 全表 LIKE。索引表保留 id 供权限过滤后回连权威表。
CREATE VIRTUAL TABLE org_memories_fts USING fts5(
  memory_id UNINDEXED,
  content,
  kind,
  tokenize='unicode61'
);
INSERT INTO org_memories_fts(memory_id, content, kind)
SELECT id, echo_index_text(content), kind FROM org_memories;

CREATE TRIGGER org_memories_fts_insert AFTER INSERT ON org_memories BEGIN
  INSERT INTO org_memories_fts(memory_id, content, kind)
  VALUES (new.id, echo_index_text(new.content), new.kind);
END;
CREATE TRIGGER org_memories_fts_delete AFTER DELETE ON org_memories BEGIN
  DELETE FROM org_memories_fts WHERE memory_id = old.id;
END;
CREATE TRIGGER org_memories_fts_update AFTER UPDATE OF content, kind ON org_memories BEGIN
  DELETE FROM org_memories_fts WHERE memory_id = old.id;
  INSERT INTO org_memories_fts(memory_id, content, kind)
  VALUES (new.id, echo_index_text(new.content), new.kind);
END;
