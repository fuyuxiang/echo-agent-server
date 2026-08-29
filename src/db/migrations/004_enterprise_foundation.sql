-- 企业空间与文档版本基础。
--
-- scopes.kind 在 001 中被 CHECK 限制为 org/team。直接重建 scopes 会让所有
-- 外键表跟随 rename，迁移风险很高。因此 personal scope 复用一条 group_id
-- 为空的 team 物理行，并由 personal_scope_owners + v_effective_scopes 暴露
-- 逻辑 kind='personal'。后续全新 schema 可再把 effective kind 收回 scopes。

CREATE TABLE personal_scope_owners (
  scope_id TEXT PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
);

-- 为已有用户补个人云空间。用户 id 是 UUID，拼接前缀后仍全局唯一。
INSERT INTO scopes (id, kind, group_id, name)
SELECT 'personal-' || id, 'team', NULL, '我的空间'
  FROM users;

INSERT INTO personal_scope_owners (scope_id, user_id)
SELECT 'personal-' || id, id FROM users;

DROP VIEW v_user_scopes;

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
  JOIN users u  ON u.id = a.user_id AND u.status = 'active'
UNION
SELECT p.user_id, p.scope_id
  FROM personal_scope_owners p
  JOIN users u ON u.id = p.user_id AND u.status = 'active';

CREATE VIEW v_effective_scopes AS
SELECT s.id,
       CASE WHEN p.user_id IS NOT NULL THEN 'personal' ELSE s.kind END AS kind,
       s.name,
       s.group_id,
       p.user_id AS owner_user_id
  FROM scopes s
  LEFT JOIN personal_scope_owners p ON p.scope_id = s.id;

-- 一个逻辑文档对应多个不可变物理版本；检索只读取 current_document_id。
CREATE TABLE document_families (
  id                  TEXT PRIMARY KEY,
  scope_id            TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  canonical_title     TEXT NOT NULL,
  owner_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
  current_document_id TEXT,
  state               TEXT NOT NULL DEFAULT 'active'
                      CHECK (state IN ('active','archived')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_doc_family_scope_state ON document_families(scope_id, state);

ALTER TABLE documents ADD COLUMN family_id TEXT REFERENCES document_families(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN fts_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (fts_status IN ('pending','ready','failed'));
ALTER TABLE documents ADD COLUMN vector_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (vector_status IN ('pending','ready','degraded','failed'));
ALTER TABLE documents ADD COLUMN index_model_version TEXT;

-- 找到每条旧版本链的根，把同一条 supersedes 链迁入同一个 family。
WITH RECURSIVE version_chain(id, root_id) AS (
  SELECT id, id FROM documents WHERE supersedes_id IS NULL
  UNION ALL
  SELECT d.id, c.root_id
    FROM documents d
    JOIN version_chain c ON d.supersedes_id = c.id
)
INSERT INTO document_families
  (id, scope_id, canonical_title, owner_id, current_document_id, state, created_at, updated_at)
SELECT 'family-' || root.id,
       root.scope_id,
       root.title,
       root.owner_id,
       NULL,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM version_chain vc
           JOIN documents d ON d.id = vc.id
           WHERE vc.root_id = root.id AND d.status != 'archived'
         ) THEN 'active'
         ELSE 'archived'
       END,
       root.created_at,
       root.updated_at
  FROM documents root
 WHERE root.supersedes_id IS NULL;

WITH RECURSIVE version_chain(id, root_id) AS (
  SELECT id, id FROM documents WHERE supersedes_id IS NULL
  UNION ALL
  SELECT d.id, c.root_id
    FROM documents d
    JOIN version_chain c ON d.supersedes_id = c.id
)
UPDATE documents
   SET family_id = 'family-' || (
     SELECT vc.root_id FROM version_chain vc WHERE vc.id = documents.id
   );

UPDATE document_families
   SET current_document_id = (
         SELECT d.id
           FROM documents d
          WHERE d.family_id = document_families.id
            AND d.status = 'ready'
          ORDER BY d.version DESC, d.updated_at DESC
          LIMIT 1
       ),
       updated_at = COALESCE((
         SELECT MAX(d.updated_at) FROM documents d
          WHERE d.family_id = document_families.id
       ), updated_at);

CREATE INDEX idx_documents_family_version ON documents(family_id, version);

-- 为旧数据补索引健康状态。FTS 与向量分开表达，避免只有关键词索引时
-- 仍被误认为完整语义索引。
UPDATE documents
   SET fts_status = CASE
         WHEN EXISTS (SELECT 1 FROM chunks c WHERE c.doc_id = documents.id)
           THEN 'ready'
         ELSE 'pending'
       END,
       vector_status = CASE
         WHEN NOT EXISTS (SELECT 1 FROM chunks c WHERE c.doc_id = documents.id)
           THEN 'pending'
         WHEN (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = documents.id) =
              (SELECT COUNT(*) FROM chunk_vectors v
                 JOIN chunks c ON c.id = v.chunk_id
                WHERE c.doc_id = documents.id)
           THEN 'ready'
         ELSE 'degraded'
       END,
       index_model_version = CASE
         WHEN EXISTS (SELECT 1 FROM embedding_meta em
                       JOIN chunks c ON c.id = em.chunk_id
                      WHERE c.doc_id = documents.id)
           THEN (SELECT em.model_version FROM embedding_meta em
                  JOIN chunks c ON c.id = em.chunk_id
                 WHERE c.doc_id = documents.id LIMIT 1)
         ELSE NULL
       END;
