import { randomUUID } from 'node:crypto'
import type { DB } from '../db.js'

export interface Group { id: string; name: string; createdAt: number }

export function createGroup(db: DB, name: string): Group {
  const g: Group = { id: randomUUID(), name, createdAt: Date.now() }
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(g.id, g.name, g.createdAt)
  return g
}

export function listGroups(db: DB): Group[] {
  return db.prepare('SELECT id, name, created_at as createdAt FROM groups ORDER BY created_at').all() as Group[]
}
