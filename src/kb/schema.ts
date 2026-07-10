import type { DB } from '../db.js'

export function migrateKb(db: DB): void {
  db.exec(`
    CREATE TABLE kb_documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      group_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      uploader_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_kb_docs_group ON kb_documents(group_id);
    CREATE INDEX idx_kb_docs_hash ON kb_documents(hash, group_id);

    CREATE TABLE kb_knowledge_units (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      location TEXT NOT NULL,         -- JSON
      text TEXT NOT NULL,
      vector_ref TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_kb_units_group ON kb_knowledge_units(group_id);
    CREATE INDEX idx_kb_units_doc ON kb_knowledge_units(doc_id);

    CREATE TABLE kb_tables (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      sheet TEXT NOT NULL,
      schema_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_kb_tables_group ON kb_tables(group_id);
    CREATE INDEX idx_kb_tables_doc ON kb_tables(doc_id);

    CREATE TABLE kb_table_rows (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      row_json TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      FOREIGN KEY (table_id) REFERENCES kb_tables(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_kb_rows_table ON kb_table_rows(table_id);

    CREATE TABLE kb_transcripts (
      seg_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_kb_trans_group ON kb_transcripts(group_id);
    CREATE INDEX idx_kb_trans_doc ON kb_transcripts(doc_id);

    CREATE TABLE kb_qa_logs (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      citations TEXT NOT NULL,         -- JSON
      confidence TEXT NOT NULL,
      feedback INTEGER NOT NULL DEFAULT 0,  -- -1/0/1
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_kb_logs_group ON kb_qa_logs(group_id);

    CREATE VIRTUAL TABLE vec_kb_units USING vec0(
      unit_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      embedding float[1024]
    );
  `)
}
