-- Echo 组织记忆平台 — 初始 schema
--
-- 两条贯穿全表的设计:
--
-- 1. 权限在检索 SQL 内联强制,不做后置过滤。后置过滤时未授权 chunk 已进入
--    进程内存、模型上下文和日志,等于泄露。为此 chunks 冗余了 scope_id 与
--    sensitivity,让检索语句无需 join documents。
-- 2. JWT 不携带 groups/scopes。可见范围每次查询从 v_user_scopes 实时计算,
--    配合 users.token_version 比对,权限撤销在下一次查询即生效。

PRAGMA foreign_keys = ON;

-- ============ 身份与授权 ============

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,              -- argon2id
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('admin','curator','member')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),
  -- 递增即使该用户所有已签发 token 失效(改密码、禁用、权限收回)。
  token_version INTEGER NOT NULL DEFAULT 1,
  -- 密级:用户可见 sensitivity <= clearance 的文档。
  clearance     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  -- 嵌套组:子组成员自动继承父组可见性(v_user_scopes 递归展开)。
  parent_id   TEXT REFERENCES groups(id) ON DELETE SET NULL,
  description TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE user_groups (
  user_id  TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

-- scope = 知识的可见性单元。org 全局一条;每个 group 一条。
-- personal 层不落 server —— 个人数据留在员工机器上。
CREATE TABLE scopes (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('org','team')),
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  UNIQUE (kind, group_id)
);

-- 用户可见 scope 的权威定义,含嵌套组继承。检索 SQL 内联此视图。
-- 禁用用户不出现在结果里,故禁用后立即失去全部可见性。
CREATE VIEW v_user_scopes AS
WITH RECURSIVE ancestry(user_id, group_id) AS (
  SELECT ug.user_id, ug.group_id FROM user_groups ug
  UNION
  SELECT a.user_id, g.parent_id
    FROM ancestry a
    JOIN groups g ON g.id = a.group_id
   WHERE g.parent_id IS NOT NULL
)
SELECT u.id AS user_id, s.id AS scope_id
  FROM users u
  JOIN scopes s ON s.kind = 'org'
 WHERE u.status = 'active'
UNION
SELECT a.user_id, s.id
  FROM ancestry a
  JOIN scopes s ON s.kind = 'team' AND s.group_id = a.group_id
  JOIN users u  ON u.id = a.user_id AND u.status = 'active';

-- ============ 文档与摄取 ============

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  scope_id      TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  source_type   TEXT NOT NULL
                CHECK (source_type IN ('pdf','docx','pptx','xlsx','md','txt',
                                       'image','audio','video','web','qa','meeting')),
  storage_key   TEXT,                       -- 对象存储键;纯文本类可为空
  content_hash  TEXT NOT NULL,              -- sha256,用于去重与增量重建
  byte_size     INTEGER NOT NULL DEFAULT 0,
  -- "这事该问谁"的依据,也是知识维护责任人。
  owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  sensitivity   INTEGER NOT NULL DEFAULT 0, -- 0 公开 1 内部 2 机密
  -- volatile 文档超过 stale 阈值后,答案里附"可能过时"提示。
  volatility    TEXT NOT NULL DEFAULT 'stable'
                CHECK (volatility IN ('stable','volatile')),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','parsing','chunking','embedding',
                                  'ready','failed','archived')),
  fail_reason   TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  indexed_at    INTEGER
);
CREATE INDEX idx_doc_scope_status ON documents(scope_id, status);
CREATE INDEX idx_doc_hash ON documents(content_hash, scope_id);
CREATE INDEX idx_doc_owner ON documents(owner_id);

CREATE TABLE doc_tags (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag    TEXT NOT NULL,
  PRIMARY KEY (doc_id, tag)
);
CREATE INDEX idx_doc_tags_tag ON doc_tags(tag);

CREATE TABLE chunks (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- scope_id / sensitivity 冗余自 documents,让检索 SQL 免 join。
  -- 改 documents.scope_id 时必须同步更新此列(见 dao/documents.ts)。
  scope_id     TEXT NOT NULL,
  sensitivity  INTEGER NOT NULL DEFAULT 0,
  seq          INTEGER NOT NULL,            -- 文档内序号
  text         TEXT NOT NULL,
  token_count  INTEGER NOT NULL DEFAULT 0,
  -- 定位信息:引用溯源靠它跳转。缺失则引用不可点击。
  loc_page     INTEGER,                     -- pdf/pptx 页码
  loc_start_ms INTEGER,                     -- 音视频起始毫秒
  loc_end_ms   INTEGER,
  heading      TEXT,                        -- 完整标题链 "第3章 > 3.2 权限"
  modality     TEXT NOT NULL DEFAULT 'text'
               CHECK (modality IN ('text','caption','transcript')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_chunk_doc ON chunks(doc_id, seq);
CREATE INDEX idx_chunk_scope ON chunks(scope_id);

-- BM25 全文索引。external content 模式避免文本双份存储。
--
-- 中文注意:unicode61 对 CJK 按单字切分,"报销审批"会被切成四个字,
-- 多字词召回极差。摄取时写入 "原文 + bigram 化副本"(报销 销审 审批),
-- 检索时同样 bigram 化查询串。索引体积约 1.8x,换来可用的中文召回。
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content='',                               -- contentless:自行管理写入
  tokenize='unicode61'
);

-- 向量表。维度随嵌入模型定,1024 对应 bge-m3。
-- 换模型需重建此表 —— 不同模型的向量空间不可混用。
CREATE VIRTUAL TABLE chunk_vectors USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);

CREATE TABLE embedding_meta (
  chunk_id      TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  -- 换嵌入模型时按此列筛出待重建的 chunk,支持后台渐进重建。
  model_version TEXT NOT NULL,
  fts_rowid     INTEGER,                    -- 对应 chunks_fts 的 rowid
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_emb_model ON embedding_meta(model_version);

-- 摄取任务队列。库内队列对百人规模够用,不引入 Redis。
CREATE TABLE ingest_jobs (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL
              CHECK (stage IN ('parse','chunk','embed','finalize')),
  state       TEXT NOT NULL DEFAULT 'queued'
              CHECK (state IN ('queued','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  -- worker 租约。进程重启后超期的 running 任务可被重新领取,
  -- 否则文档会永久卡在 parsing 状态。
  lease_until INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_job_pick ON ingest_jobs(state, lease_until);
CREATE INDEX idx_job_doc ON ingest_jobs(doc_id);

-- ============ 组织记忆 ============
-- 文档是原始资料;memory 是被提炼过的、可直接注入提示词的短陈述。

CREATE TABLE org_memories (
  id          TEXT PRIMARY KEY,
  scope_id    TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL
              CHECK (kind IN ('fact','decision','convention','pitfall','howto')),
  content     TEXT NOT NULL,                -- 一条陈述,建议 <= 300 字
  rationale   TEXT,                         -- 为什么成立
  evidence    TEXT,                         -- JSON: [{type,id,loc}]
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  confidence  REAL NOT NULL DEFAULT 0.8,
  hit_count   INTEGER NOT NULL DEFAULT 0,   -- 命中次数,用于排序与衰减
  valid_until INTEGER,                      -- 到期降权并提示复核
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','superseded','retired')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_mem_scope ON org_memories(scope_id, status);

CREATE TABLE memory_conflicts (
  id         TEXT PRIMARY KEY,
  a_id       TEXT NOT NULL REFERENCES org_memories(id) ON DELETE CASCADE,
  b_id       TEXT NOT NULL REFERENCES org_memories(id) ON DELETE CASCADE,
  reason     TEXT,
  resolution TEXT CHECK (resolution IN ('keep_a','keep_b','merge','both_ok')),
  created_at INTEGER NOT NULL
);

-- ============ 知识提升与审核 ============
-- 员工日常工作产出的候选知识在此排队。审核人可在通过前直接修订,
-- 避免提交人反复返工 —— 这是组织层质量的关键闸门。

CREATE TABLE promotions (
  id           TEXT PRIMARY KEY,
  submitter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  payload_type TEXT NOT NULL CHECK (payload_type IN ('document','memory')),
  payload      TEXT NOT NULL,               -- JSON
  source       TEXT NOT NULL
               CHECK (source IN ('meeting','qa','task','manual')),
  state        TEXT NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending','approved','rejected','withdrawn')),
  reviewer_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_note  TEXT,
  result_id    TEXT,                        -- 通过后生成的 doc_id / memory_id
  created_at   INTEGER NOT NULL,
  reviewed_at  INTEGER
);
CREATE INDEX idx_promo_pending ON promotions(state, target_scope);
CREATE INDEX idx_promo_submitter ON promotions(submitter_id);

-- ============ 质量与审计 ============

CREATE TABLE qa_events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  answered     INTEGER NOT NULL,            -- 0 = 明确回答"没找到"
  cited_chunks TEXT,                        -- JSON 数组:实际被引用的 chunk
  top_score    REAL,
  latency_ms   INTEGER,
  route        TEXT CHECK (route IN ('fast','agentic')),
  feedback     TEXT CHECK (feedback IN ('helpful','not_helpful','wrong')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_qa_time ON qa_events(created_at);
CREATE INDEX idx_qa_user ON qa_events(user_id);

CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,                 -- retrieve|upload|delete|approve|login|config_change
  target     TEXT,
  detail     TEXT,                          -- JSON
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_time ON audit_logs(created_at);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at);

-- ============ 客户端同步 ============

CREATE TABLE sync_cursors (
  device_id TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cursor    INTEGER NOT NULL DEFAULT 0,     -- 上次同步的 updated_at 水位
  synced_at INTEGER
);

-- ============ 模型配置 ============
-- Key 加密存储,且不下发到客户端 —— 推理走 server 代理,
-- 这样 Key 只存在一处,且能统一做成本归因与限流。

CREATE TABLE model_configs (
  id            TEXT PRIMARY KEY DEFAULT 'default',
  chat_provider TEXT NOT NULL,
  chat_model    TEXT NOT NULL,
  chat_base_url TEXT,
  chat_key_enc  TEXT,                       -- AES-256-GCM
  embed_model   TEXT NOT NULL,
  embed_dim     INTEGER NOT NULL,
  rerank_model  TEXT,
  vlm_model     TEXT,
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    INTEGER NOT NULL
);
