-- Projects reuse knowledge scopes, but membership is explicit and never inherited
-- from an organization department/group. No personal chat is migrated here.
CREATE TABLE projects (
 id TEXT PRIMARY KEY,
 scope_id TEXT NOT NULL UNIQUE REFERENCES scopes(id),
 name TEXT NOT NULL,
 goal TEXT NOT NULL DEFAULT '',
 owner_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE project_members (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('admin','collaborator','viewer')),
 joined_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,user_id)
);
CREATE INDEX project_members_user ON project_members(user_id,project_id);
CREATE TABLE project_tasks (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 acceptance TEXT NOT NULL DEFAULT '',
 assignee_id TEXT REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','blocked','review','accepted')),
 revision INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX project_tasks_project ON project_tasks(project_id,updated_at);
CREATE TABLE project_runs (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES project_tasks(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 session_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
 task_revision INTEGER NOT NULL,
 model_id TEXT,
 expert_name TEXT,
 expert_version TEXT,
 summary TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX project_runs_project ON project_runs(project_id,updated_at);
CREATE TABLE project_decisions (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 content TEXT NOT NULL,
 rationale TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','active','superseded','retired')),
 source_task_id TEXT REFERENCES project_tasks(id),
 source_document_id TEXT REFERENCES documents(id),
 supersedes_id TEXT REFERENCES project_decisions(id),
 confirmed_by TEXT REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX project_decisions_project ON project_decisions(project_id,status);
CREATE TABLE project_events (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
-- Preserve the old scope rules verbatim, then add explicit project membership.
DROP VIEW v_user_scopes;
CREATE VIEW v_user_scopes AS
WITH RECURSIVE ancestry(user_id,group_id) AS (
 SELECT user_id,group_id FROM user_groups
 UNION
 SELECT a.user_id,g.parent_id FROM ancestry a JOIN groups g ON g.id=a.group_id WHERE g.parent_id IS NOT NULL
)
SELECT u.id AS user_id,s.id AS scope_id FROM users u JOIN scopes s ON s.kind='org' WHERE u.status='active'
UNION
SELECT a.user_id,s.id FROM ancestry a JOIN scopes s ON s.kind='team' AND s.group_id=a.group_id JOIN users u ON u.id=a.user_id AND u.status='active'
UNION
SELECT p.user_id,p.scope_id FROM personal_scope_owners p JOIN users u ON u.id=p.user_id AND u.status='active'
UNION
SELECT m.user_id,p.scope_id FROM project_members m JOIN projects p ON p.id=m.project_id JOIN users u ON u.id=m.user_id AND u.status='active';
