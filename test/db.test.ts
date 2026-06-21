import { describe, it, expect, afterEach } from 'vitest'
import { getDb } from '../src/db.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Use a temp file instead of :memory: because sqlite-vec may fail on in-memory DBs
function makeTmpPath() {
  return join(tmpdir(), `db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

describe('db migrations', () => {
  const created: string[] = []

  afterEach(() => {
    for (const p of created) {
      try { rmSync(p) } catch { /* ignore */ }
    }
    created.length = 0
  })

  it('creates all tables on a fresh db', () => {
    const path = makeTmpPath()
    created.push(path)
    const db = getDb(path)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name)
    expect(names).toEqual(expect.arrayContaining(['users', 'groups', 'project_memories', 'model_configs']))
    db.close()
  })

  it('creates vec_memories virtual table', () => {
    const path = makeTmpPath()
    created.push(path)
    const db = getDb(path)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name)
    expect(names).toContain('vec_memories')
    db.close()
  })

  it('is idempotent — calling getDb twice does not re-run migrations', () => {
    const path = makeTmpPath()
    created.push(path)
    const db1 = getDb(path)
    db1.close()
    // Should not throw "table already exists"
    const db2 = getDb(path)
    db2.close()
  })
})
