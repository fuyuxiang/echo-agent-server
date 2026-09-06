-- 任务上下文与经验记忆闭环。
-- 组织记忆不仅回答问题，还应携带来源、时效、工作空间和结果，供 Agent
-- 在执行前召回，在执行后形成受治理的经验候选。

ALTER TABLE org_memories ADD COLUMN observed_at INTEGER;
ALTER TABLE org_memories ADD COLUMN valid_from INTEGER;
ALTER TABLE org_memories ADD COLUMN supersedes_id TEXT REFERENCES org_memories(id) ON DELETE SET NULL;
ALTER TABLE org_memories ADD COLUMN source_session_id TEXT;
ALTER TABLE org_memories ADD COLUMN source_task_id TEXT;
ALTER TABLE org_memories ADD COLUMN workspace_ref TEXT;
ALTER TABLE org_memories ADD COLUMN outcome TEXT;
ALTER TABLE org_memories ADD COLUMN sensitivity INTEGER NOT NULL DEFAULT 0 CHECK (sensitivity BETWEEN 0 AND 3);
ALTER TABLE org_memories ADD COLUMN trust TEXT NOT NULL DEFAULT 'reviewed' CHECK (trust IN ('reported','reviewed','verified'));

CREATE INDEX idx_org_memories_context
  ON org_memories(status, workspace_ref, kind, valid_until, updated_at);
CREATE INDEX idx_org_memories_supersedes ON org_memories(supersedes_id);

CREATE TABLE knowledge_usage_events (
  id            TEXT PRIMARY KEY,
  trace_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN ('context','answer','apply','feedback')),
  query         TEXT,
  task_id       TEXT,
  session_id    TEXT,
  workspace_ref TEXT,
  result_ids    TEXT,
  citation_ids  TEXT,
  outcome       TEXT CHECK (outcome IN ('unknown','helpful','unhelpful','applied','failed')),
  feedback      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_knowledge_usage_trace ON knowledge_usage_events(trace_id, created_at);
CREATE INDEX idx_knowledge_usage_user ON knowledge_usage_events(user_id, created_at DESC);

-- 归一化的逐结果反馈，供离线评估与后续安全调权使用。在线检索不直接
-- 根据单次反馈改 confidence，避免恶意或偶然反馈即时污染全组织排序。
CREATE TABLE knowledge_result_feedback (
  id          TEXT PRIMARY KEY,
  trace_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result_id   TEXT NOT NULL,
  result_kind TEXT NOT NULL CHECK (result_kind IN ('memory','citation')),
  outcome     TEXT NOT NULL CHECK (outcome IN ('unknown','helpful','unhelpful','applied','failed')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_knowledge_feedback_result
  ON knowledge_result_feedback(result_kind, result_id, created_at DESC);
CREATE INDEX idx_knowledge_feedback_trace
  ON knowledge_result_feedback(trace_id, user_id);
