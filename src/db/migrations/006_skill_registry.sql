-- 受管 Skill 注册表。family 是稳定身份，version 是不可变发布物；
-- 同一 scope 内 slug 唯一，只有 current_version_id 会被客户端同步。

CREATE TABLE skill_families (
  id                      TEXT PRIMARY KEY,
  scope_id                TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  slug                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL,
  owner_id                TEXT REFERENCES users(id) ON DELETE SET NULL,
  current_version_id      TEXT,
  state                   TEXT NOT NULL DEFAULT 'active'
                          CHECK (state IN ('active','revoked')),
  mandatory               INTEGER NOT NULL DEFAULT 0,
  allow_personal_override INTEGER NOT NULL DEFAULT 1,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (scope_id, slug)
);
CREATE INDEX idx_skill_family_scope_state ON skill_families(scope_id, state, updated_at);

CREATE TABLE skill_versions (
  id             TEXT PRIMARY KEY,
  family_id      TEXT NOT NULL REFERENCES skill_families(id) ON DELETE CASCADE,
  version        TEXT NOT NULL,
  package_key    TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  package_bytes  INTEGER NOT NULL,
  manifest_json  TEXT NOT NULL,
  signature      TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','approved','rejected','revoked')),
  submitter_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_note    TEXT,
  created_at     INTEGER NOT NULL,
  reviewed_at    INTEGER,
  published_at   INTEGER,
  UNIQUE (family_id, version)
);
CREATE INDEX idx_skill_version_review ON skill_versions(state, created_at);
