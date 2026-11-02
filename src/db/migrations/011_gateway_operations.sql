-- Additive migration: existing knowledge and account identifiers are preserved.
ALTER TABLE users ADD COLUMN department_id TEXT REFERENCES groups(id) ON DELETE SET NULL;
CREATE TABLE api_keys (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_enc TEXT NOT NULL,
 prefix TEXT NOT NULL, token_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id, device_id, revoked_at);
CREATE TABLE gateway_settings (
 id TEXT PRIMARY KEY CHECK(id='default'), revision INTEGER NOT NULL DEFAULT 1,
 public_base_url TEXT, max_output_tokens INTEGER NOT NULL DEFAULT 8192,
 models_json TEXT NOT NULL DEFAULT '{}', protocols TEXT NOT NULL DEFAULT '["chat"]', input_price REAL, cached_price REAL,
 output_price REAL, currency TEXT NOT NULL DEFAULT 'CNY', updated_at INTEGER NOT NULL
);
INSERT INTO gateway_settings(id,updated_at) VALUES('default',0);
CREATE TABLE model_config_history (
 id TEXT PRIMARY KEY, config_json TEXT NOT NULL, gateway_json TEXT NOT NULL,
 actor_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE model_calls (
 id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 user_name TEXT, department_id TEXT, department_name TEXT, key_id TEXT,
 device_id TEXT, task_id TEXT, asset_id TEXT, source TEXT NOT NULL,
 model TEXT NOT NULL, protocol TEXT NOT NULL, started_at INTEGER NOT NULL,
 finished_at INTEGER, http_status INTEGER, outcome TEXT NOT NULL DEFAULT 'running',
 accounting_state TEXT NOT NULL DEFAULT 'pending', input_tokens INTEGER,
 output_tokens INTEGER, cached_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
 total_tokens INTEGER, reserved_tokens INTEGER NOT NULL DEFAULT 0,
 cost_source TEXT NOT NULL DEFAULT 'estimated', reserved_cost REAL, estimated_cost REAL, currency TEXT, price_revision INTEGER,
 price_json TEXT, upstream_request_id TEXT, error_code TEXT,
 units_json TEXT, reconciled_by TEXT, reconciled_at INTEGER
);
CREATE INDEX idx_calls_time ON model_calls(started_at);
CREATE INDEX idx_calls_user ON model_calls(user_id,started_at);
CREATE INDEX idx_calls_dept ON model_calls(department_id,started_at);
CREATE TABLE quota_rules (
 id TEXT PRIMARY KEY, target_type TEXT NOT NULL CHECK(target_type IN ('org','department','user','key')),
 target_id TEXT NOT NULL, window TEXT NOT NULL CHECK(window IN ('day','month','rolling')),
 window_hours INTEGER NOT NULL DEFAULT 5, token_limit INTEGER, cost_limit REAL,
 currency TEXT NOT NULL DEFAULT 'CNY', rpm INTEGER, concurrency INTEGER,
 action TEXT NOT NULL DEFAULT 'block' CHECK(action IN ('block','warn')),
 enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
 UNIQUE(target_type,target_id,window)
);
CREATE TABLE client_devices (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT NOT NULL,
 name TEXT, version TEXT, platform TEXT, last_seen_at INTEGER NOT NULL,
 policy_version INTEGER, config_revision INTEGER, receipt_json TEXT,
 PRIMARY KEY(user_id,device_id)
);
CREATE TABLE maintenance_tasks (
 id TEXT PRIMARY KEY, question TEXT NOT NULL, source_event_id TEXT,
 owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','working','verified','closed')),
 note TEXT, result_asset_id TEXT, created_by TEXT, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE notification_reads (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, notification_id TEXT NOT NULL,
 read_at INTEGER NOT NULL, PRIMARY KEY(user_id,notification_id)
);
CREATE TABLE memory_versions (
 id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES org_memories(id) ON DELETE CASCADE,
 snapshot_json TEXT NOT NULL, actor_id TEXT, created_at INTEGER NOT NULL
);
CREATE TRIGGER memory_history BEFORE UPDATE OF kind,content,rationale,evidence,confidence,trust,observed_at,valid_from,valid_until,source_session_id,source_task_id,workspace_ref,outcome,sensitivity,status ON org_memories BEGIN
 INSERT INTO memory_versions(id,memory_id,snapshot_json,created_at)
 VALUES(lower(hex(randomblob(16))),old.id,json_object('kind',old.kind,'content',old.content,'rationale',old.rationale,'evidence',old.evidence,'confidence',old.confidence,'trust',old.trust,'validFrom',old.valid_from,'validUntil',old.valid_until,'status',old.status,'sensitivity',old.sensitivity,'observedAt',old.observed_at,'sourceSessionId',old.source_session_id,'sourceTaskId',old.source_task_id,'workspaceRef',old.workspace_ref,'outcome',old.outcome,'updatedAt',old.updated_at),CAST(unixepoch('subsec')*1000 AS INTEGER));
END;

ALTER TABLE ingest_jobs ADD COLUMN requested_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE document_submissions ADD COLUMN review_lock TEXT;
ALTER TABLE document_submissions ADD COLUMN review_lease_until INTEGER;
ALTER TABLE skill_versions ADD COLUMN review_lock TEXT;
ALTER TABLE skill_versions ADD COLUMN review_lease_until INTEGER;
ALTER TABLE promotions ADD COLUMN review_lock TEXT;
ALTER TABLE promotions ADD COLUMN review_lease_until INTEGER;
CREATE TABLE policy_history(version INTEGER PRIMARY KEY,snapshot_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TRIGGER policy_history_save BEFORE UPDATE ON enterprise_policy BEGIN
 INSERT OR IGNORE INTO policy_history VALUES(old.version,json_object('allowLocalKnowledge',json(CASE old.allow_local_knowledge WHEN 1 THEN 'true' ELSE 'false' END),'allowPersonalCloud',json(CASE old.allow_personal_cloud WHEN 1 THEN 'true' ELSE 'false' END),'allowSkillSubmission',json(CASE old.allow_skill_submission WHEN 1 THEN 'true' ELSE 'false' END),'offlineEnterpriseContent',json(CASE old.offline_enterprise WHEN 1 THEN 'true' ELSE 'false' END),'managedSkillLeaseHours',old.managed_lease_hours),old.updated_at);
END;
