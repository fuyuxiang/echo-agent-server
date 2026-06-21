import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { hashEmbedding } from '../src/embedding.js'
import { createUser } from '../src/dao/users.js'
import { buildApp } from '../src/app.js'

process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
let db: DB
const embed = { embed: async (t: string) => hashEmbedding(t) }
beforeEach(() => { db = getDb(':memory:') })

async function login(app: any, u: string, p: string) {
  return (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().data.token
}

describe('admin & model-config routes', () => {
  it('admin creates group+user, member cannot', async () => {
    await createUser(db, { username: 'root', password: 'pw', role: 'admin', groupId: null })
    const app = buildApp({ db, embed })
    const t = await login(app, 'root', 'pw')
    const g = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: { authorization: `Bearer ${t}` }, payload: { name: '研发' } })
    expect(g.json().code).toBe(0)
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${t}` }, payload: { username: 'm', password: 'pw', role: 'member', groupId: g.json().data.id } })
    const tm = await login(app, 'm', 'pw')
    const denied = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: { authorization: `Bearer ${tm}` }, payload: { name: 'x' } })
    expect(denied.statusCode).toBe(403)
  })

  it('model-config hides credential plaintext', async () => {
    await createUser(db, { username: 'root', password: 'pw', role: 'admin', groupId: null })
    const app = buildApp({ db, embed })
    const t = await login(app, 'root', 'pw')
    await app.inject({ method: 'PUT', url: '/api/admin/model-config', headers: { authorization: `Bearer ${t}` }, payload: { baseUrl: 'https://api.x', modelName: 'gpt', credential: 'sk-secret', allowLocalOverride: false } })
    const got = await app.inject({ method: 'GET', url: '/api/model-config', headers: { authorization: `Bearer ${t}` } })
    expect(JSON.stringify(got.json())).not.toContain('sk-secret')
    expect(got.json().data.hasCredential).toBe(true)
  })
})
