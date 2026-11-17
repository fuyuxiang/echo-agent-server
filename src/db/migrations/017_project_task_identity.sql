-- Task identity remains stable when a desktop retries a lost create response.
-- This additive table leaves all existing tasks, runs and documents untouched.
CREATE TABLE project_task_requests (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
 PRIMARY KEY(project_id,actor_id,request_key)
);
