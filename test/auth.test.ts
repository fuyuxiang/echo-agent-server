import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { hashEmbedding } from '../src/embedding.js'
import { createGroup } from '../src/dao/groups.js'
import { createUser } from '../src/dao/users.js'
import { buildApp } from '../src/app.js'

process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
let db: DB
beforeEach(() => { db = getDb(':memory:') })

describe('auth', () => {
  it('logs in with correct credentials and rejects wrong', async () => {
    const g = createGroup(db, 'g1')
    await createUser(db, { username: 'alice', password: 'pw', role: 'member', groupId: g.id })
    const app = buildApp({ db, embed: { embed: async (t) => hashEmbedding(t) } })

    const okRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'pw' } })
    expect(okRes.json().code).toBe(0)
    expect(okRes.json().data.token).toBeTypeOf('string')

    const badRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'no' } })
    expect(badRes.json().code).not.toBe(0)
  }, 15000)
})
