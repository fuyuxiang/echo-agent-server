import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, type DB } from '../src/db.js'
import { hashEmbedding } from '../src/embedding.js'
import { addMemory, searchMemories, listMemories, deleteMemory } from '../src/dao/memories.js'

// sqlite-vec does not support :memory: — use a temp file per test
function makeTmpPath() {
  return join(tmpdir(), `mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

const embed = { embed: async (t: string) => hashEmbedding(t) }
let db: DB
let dbPath: string

beforeEach(() => {
  dbPath = makeTmpPath()
  db = getDb(dbPath)
})

afterEach(() => {
  db.close()
  try { rmSync(dbPath) } catch { /* ignore */ }
})

describe('project memory dao', () => {
  it('search only returns memories of the same group', async () => {
    await addMemory(db, embed, { groupId: 'g1', content: '部署流程用 k8s', tags: [], sourceUser: 'u1' })
    await addMemory(db, embed, { groupId: 'g2', content: '部署流程用 k8s', tags: [], sourceUser: 'u2' })
    const res = await searchMemories(db, embed, { groupId: 'g1', query: '部署流程', topK: 5 })
    expect(res.length).toBeGreaterThanOrEqual(1)
    expect(res.every((m) => m.groupId === 'g1')).toBe(true)
  })

  it('lists and deletes within group scope', async () => {
    const m = await addMemory(db, embed, { groupId: 'g1', content: 'x', tags: ['a'], sourceUser: 'u1' })
    expect(listMemories(db, { groupId: 'g1', limit: 10, offset: 0 })).toHaveLength(1)
    expect(deleteMemory(db, { groupId: 'g2', id: m.id })).toBe(false) // 跨组删不掉
    expect(deleteMemory(db, { groupId: 'g1', id: m.id })).toBe(true)
  })
})
