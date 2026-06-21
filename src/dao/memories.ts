import { randomUUID } from 'node:crypto'
import type { DB } from '../db.js'
import type { EmbeddingProvider } from '../embedding.js'

export interface Memory {
  id: string
  groupId: string
  content: string
  tags: string[]
  sourceUser: string
  createdAt: number
  updatedAt: number
}

interface Row {
  id: string
  group_id: string
  content: string
  tags: string
  source_user: string
  created_at: number
  updated_at: number
}

function toMem(r: Row): Memory {
  return {
    id: r.id,
    groupId: r.group_id,
    content: r.content,
    tags: JSON.parse(r.tags),
    sourceUser: r.source_user,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function addMemory(
  db: DB,
  embed: EmbeddingProvider,
  input: { groupId: string; content: string; tags: string[]; sourceUser: string }
): Promise<Memory> {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO project_memories (id, group_id, content, tags, source_user, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, input.groupId, input.content, JSON.stringify(input.tags), input.sourceUser, now, now)
  const vec = await embed.embed(input.content)
  db.prepare('INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)').run(
    id,
    new Float32Array(vec)
  )
  return {
    id,
    groupId: input.groupId,
    content: input.content,
    tags: input.tags,
    sourceUser: input.sourceUser,
    createdAt: now,
    updatedAt: now,
  }
}

export async function searchMemories(
  db: DB,
  embed: EmbeddingProvider,
  input: { groupId: string; query: string; topK: number }
): Promise<Memory[]> {
  const vec = await embed.embed(input.query)
  // Step 1: KNN query to get candidate memory_ids with distances
  // sqlite-vec requires the MATCH + k = ? to be the only WHERE clause on the virtual table
  const candidates = db
    .prepare(
      `SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ?`
    )
    .all(new Float32Array(vec), input.topK) as { memory_id: string; distance: number }[]

  if (candidates.length === 0) return []

  // Step 2: fetch project_memories for these candidates, enforcing group_id isolation
  const ids = candidates.map((c) => c.memory_id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT * FROM project_memories WHERE id IN (${placeholders}) AND group_id = ? ORDER BY created_at DESC`
    )
    .all(...ids, input.groupId) as Row[]

  // Preserve distance ordering from KNN result
  const distMap = new Map(candidates.map((c) => [c.memory_id, c.distance]))
  rows.sort((a, b) => (distMap.get(a.id) ?? 0) - (distMap.get(b.id) ?? 0))

  return rows.map(toMem)
}

export function listMemories(
  db: DB,
  input: { groupId: string; limit: number; offset: number }
): Memory[] {
  const rows = db
    .prepare(
      'SELECT * FROM project_memories WHERE group_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    )
    .all(input.groupId, input.limit, input.offset) as Row[]
  return rows.map(toMem)
}

export function deleteMemory(db: DB, input: { groupId: string; id: string }): boolean {
  const res = db
    .prepare('DELETE FROM project_memories WHERE id = ? AND group_id = ?')
    .run(input.id, input.groupId)
  if (res.changes > 0) {
    db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(input.id)
    return true
  }
  return false
}
