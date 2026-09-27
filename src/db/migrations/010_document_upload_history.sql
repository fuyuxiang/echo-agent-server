-- Keep historical submissions for audit while allowing their owner to remove
-- an entry from the personal upload list. Existing entries remain visible.
ALTER TABLE document_submissions ADD COLUMN hidden_by_submitter INTEGER NOT NULL DEFAULT 0
  CHECK (hidden_by_submitter IN (0,1));
CREATE INDEX idx_doc_submission_visible_owner
  ON document_submissions(submitter_id, hidden_by_submitter, created_at);
