-- Stable sharing requests allow a local project to enable collaboration safely
-- even if the successful first response was lost. Existing projects are untouched.
CREATE TABLE project_creation_keys (
 owner_id TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 PRIMARY KEY(owner_id,request_key)
);
