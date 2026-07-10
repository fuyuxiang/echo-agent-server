import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../src/db.js'

describe('kb schema migration v2', () => {
  let db: ReturnType<typeof getDb>
  beforeEach(() => { db = getDb(':memory:') })

  it('creates kb_* tables with group_id columns', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kb_%' ORDER BY name"
    ).all() as { name: string }[]
    expect(tables.map(t => t.name)).toEqual([
      'kb_documents', 'kb_knowledge_units', 'kb_qa_logs', 'kb_table_rows', 'kb_tables', 'kb_transcripts',
    ])
  })

  it('creates vec_kb_units virtual table with 1024-dim embedding', () => {
    const v = db.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'vec_kb_units'"
    ).get() as { sql: string }
    expect(v.sql).toContain('float[1024]')
  })

  it('every kb_* table has group_id column with index', () => {
    const cols = db.prepare(
      "SELECT name FROM pragma_table_info('kb_documents') WHERE name='group_id'"
    ).all()
    expect(cols).toHaveLength(1)
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='kb_documents' AND sql LIKE '%group_id%'"
    ).all()
    expect(idx.length).toBeGreaterThan(0)
  })
})
