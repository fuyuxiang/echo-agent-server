import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/app.js'
import { getDb } from '../../src/db.js'
import { createGroup } from '../../src/dao/groups.js'
import { createUser } from '../../src/dao/users.js'
import type { FastifyInstance } from 'fastify'

process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
process.env.ECHO_SERVER_DB = ':memory:'

describe('kb routes skeleton', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    const db = getDb(':memory:')
    const g = createGroup(db, 'g1')
    await createUser(db, { username: 'alice', password: 'pwd12345678', role: 'member', groupId: g.id })
    app = buildApp({ db, embed: { embed: async () => new Array(1024).fill(0) } })
    await app.ready()
    const r = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: 'pwd12345678' }
    })
    token = r.json().data.token
  })
  afterAll(async () => { await app.close() })

  it('rejects unauthenticated /api/kb/ask with 401', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/kb/ask', payload: { query: 'x' } })
    expect(r.statusCode).toBe(401)
  })

  it('returns 501 for authenticated /api/kb/ask placeholder', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/kb/ask',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'x' }
    })
    expect(r.statusCode).toBe(501)
  })
})
