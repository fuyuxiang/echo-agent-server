import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { ensureInitialAdmin } from '../src/server.js'
import { listUsers } from '../src/dao/users.js'

let db: DB
beforeEach(() => { db = getDb(':memory:'); process.env.ECHO_ADMIN_USER = 'root'; process.env.ECHO_ADMIN_PASSWORD = 'rootpw' })

describe('initial admin', () => {
  it('creates an admin when db is empty, idempotent', async () => {
    await ensureInitialAdmin(db)
    await ensureInitialAdmin(db)
    const admins = listUsers(db).filter((u) => u.role === 'admin')
    expect(admins).toHaveLength(1)
    expect(admins[0].username).toBe('root')
  })
})
