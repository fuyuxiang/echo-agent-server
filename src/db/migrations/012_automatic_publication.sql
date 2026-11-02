-- Keep historical publication states and identities; new submissions are safety checked automatically.
ALTER TABLE promotions ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE promotions ADD COLUMN scan_report_json TEXT;
ALTER TABLE promotions ADD COLUMN scan_started_at INTEGER;
ALTER TABLE promotions ADD COLUMN scan_completed_at INTEGER;
ALTER TABLE promotions ADD COLUMN auto_retry_at INTEGER;
ALTER TABLE document_submissions ADD COLUMN auto_retry_at INTEGER;
ALTER TABLE skill_versions ADD COLUMN auto_retry_at INTEGER;
UPDATE promotions SET scan_status='unknown' WHERE state!='pending';
CREATE INDEX idx_promotions_auto ON promotions(auto_retry_at,created_at) WHERE state='pending';
CREATE INDEX idx_documents_auto ON document_submissions(auto_retry_at,created_at) WHERE state='pending';
CREATE INDEX idx_skills_auto ON skill_versions(auto_retry_at,created_at) WHERE state='pending';
-- Recover technical outages only. Human rejections and detected threats stay unchanged.
UPDATE document_submissions SET state='pending',auto_retry_at=0
 WHERE state='rejected' AND reviewer_id IS NULL AND scan_status='failed'
 AND json_valid(scan_report_json)
 AND EXISTS(SELECT 1 FROM json_each(scan_report_json,'$.findings') f WHERE json_extract(f.value,'$.code')='ANTIVIRUS_UNAVAILABLE')
 AND NOT EXISTS(SELECT 1 FROM json_each(scan_report_json,'$.findings') f WHERE json_extract(f.value,'$.severity') IN ('high','critical') AND json_extract(f.value,'$.code')!='ANTIVIRUS_UNAVAILABLE');
UPDATE skill_versions SET state='pending',auto_retry_at=0
 WHERE state='rejected' AND reviewer_id IS NULL AND scan_status='failed'
 AND json_valid(scan_report_json)
 AND EXISTS(SELECT 1 FROM json_each(scan_report_json,'$.findings') f WHERE json_extract(f.value,'$.code')='ANTIVIRUS_UNAVAILABLE')
 AND NOT EXISTS(SELECT 1 FROM json_each(scan_report_json,'$.findings') f WHERE json_extract(f.value,'$.severity') IN ('high','critical') AND json_extract(f.value,'$.code')!='ANTIVIRUS_UNAVAILABLE');
