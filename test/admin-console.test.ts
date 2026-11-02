import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { openDb, type DB } from '../src/db/index.js'
import { createUser } from '../src/dao/users.js'
import { testConfig } from '../src/config.js'
import { ensureOrgScope } from '../src/server.js'

let app: FastifyInstance, db: DB
const password = 'console-test-password'
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
async function login(username: string, admin = false, deviceId = 'desktop-test') {
  return app.inject({ method: 'POST', url: admin ? '/api/v1/admin/auth/login' : '/api/v1/auth/login', payload: { username, password, deviceId } })
}
beforeEach(async () => {
  db = openDb({ path: ':memory:' })
  ensureOrgScope(db)
  await createUser(db, { username: 'admin', password, role: 'admin', clearance: 2 })
  await createUser(db, { username: 'member', password, role: 'member' })
  app = buildApp({ db, cfg: testConfig(), serveWeb: false })
})
afterEach(async () => { await app.close(); db.close() })

describe('administrator console boundary', () => {
  it.each(['member', 'curator'])('rejects a %s before issuing a console session', async role => {
    db.prepare('UPDATE users SET role=? WHERE username=?').run(role, 'member')
    const res = await login('member', true)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 4033, data: null })
    expect(res.headers['set-cookie']).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get() as any).n).toBe(0)
    expect((db.prepare("SELECT last_seen_at AS lastSeen FROM users WHERE username='member'").get() as any).lastSeen).toBeNull()
  })
  it('also rejects a member through the former admin-web login contract', async () => {
    expect((await login('member', false, 'admin-web')).statusCode).toBe(403)
  })
  it('issues an isolated administrator cookie, verifies identity and rotates the session', async () => {
    const res = await login('admin', true)
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(app.jwt.decode<any>(data.accessToken)).toMatchObject({ device: 'admin-web', aud: 'admin-console' })
    expect(String(res.headers['set-cookie'])).toContain('echo_admin_refresh=')
    expect(String(res.headers['set-cookie'])).toContain('Path=/api/v1/admin/auth; HttpOnly; SameSite=Strict')
    expect((await app.inject({ url: '/api/v1/admin/auth/me', headers: bearer(data.accessToken) })).json().data.role).toBe('admin')
    const cookie = String(res.headers['set-cookie']).split(';')[0]
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/refresh', headers: { cookie }, payload: {} })
    expect(refresh.statusCode).toBe(200)
    expect(refresh.json().data.refreshToken).not.toBe(data.refreshToken)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/auth/refresh', headers: { cookie }, payload: {} })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie }, payload: {} })).statusCode).toBe(400)
  })
  it('does not exchange or consume a desktop session at the console refresh endpoint', async () => {
    const desktop = (await login('member')).json().data
    const attempt = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/refresh', payload: { refreshToken: desktop.refreshToken } })
    expect(attempt.statusCode).toBe(401)
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: desktop.refreshToken } })
    expect(refresh.statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/me', headers: bearer(refresh.json().data.accessToken) })).statusCode).toBe(200)
  })
  it('denies console identity and overview to desktop members and knowledge reviewers', async () => {
    for (const role of ['member', 'curator']) {
      db.prepare('UPDATE users SET role=? WHERE username=?').run(role, 'member')
      const token = (await login('member')).json().data.accessToken
      for (const url of ['/api/v1/admin/auth/me', '/api/v1/admin/workspace', '/api/v1/workspace']) {
        expect((await app.inject({ url, headers: bearer(token) })).statusCode).toBe(403)
      }
      expect((await app.inject({ url: '/api/v1/client/bootstrap', headers: bearer(token) })).statusCode).not.toBe(403)
    }
  })
  it('revokes a demoted administrator on every request and during renewal', async () => {
    const session = (await login('admin', true)).json().data
    db.prepare("UPDATE users SET role='member' WHERE username='admin'").run()
    const res = await app.inject({ url: '/api/v1/usage', headers: bearer(session.accessToken) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe(4033)
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/refresh', payload: { refreshToken: session.refreshToken } })
    expect(refresh.statusCode).toBe(403)
    expect(refresh.json().data).toBeNull()
  })
  it('rejects disabled administrators and clears the console cookie on logout', async () => {
    const session = (await login('admin', true)).json().data
    const out = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/logout', headers: bearer(session.accessToken) })
    expect(out.statusCode).toBe(200)
    expect(String(out.headers['set-cookie'])).toContain('echo_admin_refresh=; Path=/api/v1/admin/auth; HttpOnly; SameSite=Strict; Max-Age=0')
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/auth/refresh', payload: { refreshToken: session.refreshToken } })).statusCode).toBe(401)
    db.prepare("UPDATE users SET status='disabled' WHERE username='admin'").run()
    expect((await login('admin', true)).statusCode).toBe(401)
  })
  it('reports shared knowledge and operational work rather than the administrator personal library', async () => {
    const admin = (db.prepare("SELECT id FROM users WHERE username='admin'").get() as any).id
    const now = Date.now()
    db.prepare('INSERT INTO documents(id,scope_id,title,source_type,storage_key,content_hash,status,sensitivity,volatility,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('private', `personal-${admin}`, 'private notes', 'txt', 'private.txt', 'private-hash', 'ready', 0, 'stable', now, now)
    db.prepare("INSERT INTO maintenance_tasks(id,question,state,created_at,updated_at) VALUES('work','Review evidence','working',?,?)").run(now, now)
    const token = (await login('admin', true)).json().data.accessToken
    const data = (await app.inject({ url: '/api/v1/admin/workspace', headers: bearer(token) })).json().data
    expect(data.documents.total).toBe(0)
    expect(data.recent).toEqual([])
    expect(data.operations).toMatchObject({ activeUsers: 2, openMaintenance: 1, unsettledCalls: 0, failedJobs: 0 })
  })
})
