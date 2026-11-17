CREATE TABLE project_comments (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id),
 content TEXT NOT NULL,
 request_key TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(project_id,actor_id,request_key)
);
CREATE INDEX project_comments_recent ON project_comments(project_id,created_at);
CREATE TABLE project_decision_history (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 decision_id TEXT NOT NULL REFERENCES project_decisions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 content TEXT NOT NULL,
 rationale TEXT NOT NULL,
 status TEXT NOT NULL,
 changed_by TEXT NOT NULL REFERENCES users(id),
 changed_at INTEGER NOT NULL,
 UNIQUE(decision_id,revision)
);
