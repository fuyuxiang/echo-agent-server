-- Keep project data and audit history while revoking access to its knowledge scope.
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
ALTER TABLE projects ADD COLUMN deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;

DROP VIEW v_user_scopes;
CREATE VIEW v_user_scopes AS
WITH RECURSIVE ancestry(user_id,group_id) AS (
 SELECT user_id,group_id FROM user_groups
 UNION
 SELECT a.user_id,g.parent_id FROM ancestry a JOIN groups g ON g.id=a.group_id WHERE g.parent_id IS NOT NULL
), visible_scopes(user_id,scope_id) AS (
 SELECT u.id,s.id FROM users u JOIN scopes s ON s.kind='org' WHERE u.status='active'
 UNION
 SELECT a.user_id,s.id FROM ancestry a JOIN scopes s ON s.kind='team' AND s.group_id=a.group_id JOIN users u ON u.id=a.user_id AND u.status='active'
 UNION
 SELECT p.user_id,p.scope_id FROM personal_scope_owners p JOIN users u ON u.id=p.user_id AND u.status='active'
 UNION
 SELECT m.user_id,p.scope_id FROM project_members m JOIN projects p ON p.id=m.project_id JOIN users u ON u.id=m.user_id AND u.status='active'
)
SELECT v.user_id,v.scope_id FROM visible_scopes v
WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.scope_id=v.scope_id AND p.deleted_at IS NOT NULL);
