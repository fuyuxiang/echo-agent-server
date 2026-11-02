-- Product state is separate from publication/security verdicts. Archiving a
-- report never releases quarantined content or changes the scan result.
CREATE TABLE security_dispositions (
 kind TEXT NOT NULL CHECK(kind IN ('document','skill','promotion')),
 record_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('follow_up','handled','archived')),
 note TEXT NOT NULL,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(kind,record_id)
);
CREATE TABLE model_connection_checks (
 id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL,
 success INTEGER NOT NULL CHECK(success IN (0,1)),
 http_status INTEGER,
 latency_ms INTEGER NOT NULL,
 message TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_connection_revision ON model_connection_checks(revision,created_at DESC);
CREATE TABLE product_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO product_metadata(key,value)
 SELECT 'usage_collection_started_at',CAST(COALESCE(MIN(started_at),CAST(strftime('%s','now') AS INTEGER)*1000) AS TEXT) FROM model_calls;
ALTER TABLE maintenance_tasks ADD COLUMN verification_json TEXT;
ALTER TABLE maintenance_tasks ADD COLUMN result_asset_kind TEXT;
ALTER TABLE client_devices ADD COLUMN capabilities_json TEXT;
ALTER TABLE client_devices ADD COLUMN skill_receipt_at INTEGER;
ALTER TABLE client_devices ADD COLUMN skill_receipts_complete INTEGER;
ALTER TABLE maintenance_tasks ADD COLUMN closure_reason TEXT;
