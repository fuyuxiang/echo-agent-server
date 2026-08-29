-- 文件型知识的提交/审核流。
-- 个人云空间可直接发布；团队/公司空间中的普通员工文件先停在本表，
-- 只有审核通过后才创建 documents 记录并进入摄取队列。

CREATE TABLE document_submissions (
  id                 TEXT PRIMARY KEY,
  submitter_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_scope       TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  source_type        TEXT NOT NULL,
  storage_key        TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  byte_size          INTEGER NOT NULL DEFAULT 0,
  sensitivity        INTEGER NOT NULL DEFAULT 0,
  volatility         TEXT NOT NULL DEFAULT 'stable'
                     CHECK (volatility IN ('stable','volatile')),
  tags_json          TEXT,
  state              TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','approved','rejected','withdrawn')),
  reviewer_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_note        TEXT,
  result_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  reviewed_at        INTEGER
);

CREATE INDEX idx_doc_submission_queue
  ON document_submissions(state, target_scope, created_at);
CREATE INDEX idx_doc_submission_owner
  ON document_submissions(submitter_id, created_at);
CREATE INDEX idx_doc_submission_dedup
  ON document_submissions(target_scope, content_hash, state);
