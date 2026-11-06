-- NULL folder IDs preserve the root location of every existing document/client.
CREATE TABLE document_folders (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES document_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_document_folder_name
  ON document_folders(scope_id, COALESCE(parent_id, ''), name);
CREATE INDEX idx_document_folder_parent ON document_folders(parent_id, scope_id);
ALTER TABLE document_families ADD COLUMN folder_id TEXT REFERENCES document_folders(id) ON DELETE SET NULL;
ALTER TABLE document_submissions ADD COLUMN folder_id TEXT REFERENCES document_folders(id) ON DELETE SET NULL;
CREATE INDEX idx_document_family_folder ON document_families(folder_id, scope_id, state);
CREATE TRIGGER document_folder_parent_scope BEFORE INSERT ON document_folders
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_folders WHERE id=NEW.parent_id AND scope_id=NEW.scope_id
)
BEGIN SELECT RAISE(ABORT, 'folder scope mismatch'); END;
CREATE TRIGGER document_family_folder_scope BEFORE INSERT ON document_families
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_folders WHERE id=NEW.folder_id AND scope_id=NEW.scope_id
)
BEGIN SELECT RAISE(ABORT, 'folder scope mismatch'); END;
CREATE TRIGGER document_family_folder_scope_update BEFORE UPDATE OF folder_id,scope_id ON document_families
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_folders WHERE id=NEW.folder_id AND scope_id=NEW.scope_id
)
BEGIN SELECT RAISE(ABORT, 'folder scope mismatch'); END;
CREATE TRIGGER document_submission_folder_scope BEFORE INSERT ON document_submissions
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_folders WHERE id=NEW.folder_id AND scope_id=NEW.target_scope
)
BEGIN SELECT RAISE(ABORT, 'folder scope mismatch'); END;

-- Root titles remain unrestricted for legacy clients/data; real directory paths are unique.
CREATE UNIQUE INDEX idx_document_family_folder_name
  ON document_families(scope_id,folder_id,canonical_title)
  WHERE folder_id IS NOT NULL AND state='active';
CREATE TRIGGER document_submission_folder_scope_update BEFORE UPDATE OF folder_id,target_scope ON document_submissions
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_folders WHERE id=NEW.folder_id AND scope_id=NEW.target_scope
)
BEGIN SELECT RAISE(ABORT, 'folder scope mismatch'); END;
