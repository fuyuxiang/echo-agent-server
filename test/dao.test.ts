import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, type DB } from '../src/db.js'
import { createUser, findUserByName, listUsers, setUserGroup } from '../src/dao/users.js'
import { createGroup, listGroups } from '../src/dao/groups.js'

function makeTmpPath() {
  return join(tmpdir(), `dao-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

let db: DB
let tmpPath: string

beforeEach(() => {
  tmpPath = makeTmpPath()
  db = getDb(tmpPath)
})

afterEach(() => {
  try { db.close() } catch { /* ignore */ }
  try { rmSync(tmpPath) } catch { /* ignore */ }
})

describe('users & groups dao', () => {
  it('creates a group and a user assigned to it', async () => {
    const g = createGroup(db, '研发组')
    expect(listGroups(db)).toHaveLength(1)
    const u = await createUser(db, { username: 'alice', password: 'pw', role: 'member', groupId: g.id })
    expect(u.username).toBe('alice')
    expect((u as any).password_hash).toBeUndefined()
    expect(findUserByName(db, 'alice')?.groupId).toBe(g.id)
  })

  it('moves a user to another group', async () => {
    const g1 = createGroup(db, 'a')
    const g2 = createGroup(db, 'b')
    const u = await createUser(db, { username: 'bob', password: 'pw', role: 'member', groupId: g1.id })
    setUserGroup(db, u.id, g2.id)
    expect(findUserByName(db, 'bob')?.groupId).toBe(g2.id)
    expect(listUsers(db)).toHaveLength(1)
  })
})
