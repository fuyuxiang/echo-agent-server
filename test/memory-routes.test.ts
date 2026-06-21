import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { hashEmbedding } from '../src/embedding.js'
import { createGroup } from '../src/dao/groups.js'
import { createUser } from '../src/dao/users.js'
import { buildApp } from '../src/app.js'

process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
let db: DB
const embed = { embed: async (t: string) => hashEmbedding(t) }

async function tokenFor(app: any, username: string, password: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
  return r.json().data.token
}

beforeEach(() => { db = getDb(':memory:') })

describe('project-memory routes', () => {
  it('writes and searches within own group only', async () => {
    const g1 = createGroup(db, 'g1'); const g2 = createGroup(db, 'g2')
    await createUser(db, { username: 'a', password: 'pw', role: 'member', groupId: g1.id })
    await createUser(db, { username: 'b', password: 'pw', role: 'member', groupId: g2.id })
    const app = buildApp({ db, embed })
    const ta = await tokenFor(app, 'a', 'pw')
    const tb = await tokenFor(app, 'b', 'pw')

    await app.inject({ method: 'POST', url: '/api/project-memory', headers: { authorization: `Bearer ${ta}` }, payload: { content: 'g1 的部署规范' } })

    const sa = await app.inject({ method: 'POST', url: '/api/project-memory/search', headers: { authorization: `Bearer ${ta}` }, payload: { query: '部署规范' } })
    expect(sa.json().data.length).toBeGreaterThanOrEqual(1)

    const sb = await app.inject({ method: 'POST', url: '/api/project-memory/search', headers: { authorization: `Bearer ${tb}` }, payload: { query: '部署规范' } })
    expect(sb.json().data).toHaveLength(0) // b 组看不到 a 组记忆
  })

  it('rejects unauthenticated write', async () => {
    const app = buildApp({ db, embed })
    const res = await app.inject({ method: 'POST', url: '/api/project-memory', payload: { content: 'x' } })
    expect(res.statusCode).toBe(401)
  })
})
