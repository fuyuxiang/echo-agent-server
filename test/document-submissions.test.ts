import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { testConfig } from '../src/config.js'
import { createUser } from '../src/dao/users.js'
import { openDb, type DB } from '../src/db/index.js'
import { createEmbedder } from '../src/models/embedder.js'
import { ensureOrgScope } from '../src/server.js'
import { drain } from '../src/kb/ingest/worker.js'

let storageDir: string
let cfg: ReturnType<typeof testConfig>

function multipartBody(fields: Record<string, string>, file: { name: string; content: string }) {
  const boundary = '----EchoSubmissionBoundary123'
  const parts = Object.entries(fields).map(
    ([key, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
  )
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${file.content}\r\n`
  )
  parts.push(`--${boundary}--\r\n`)
  return {
    payload: Buffer.from(parts.join(''), 'utf8'),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  }
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, deviceId: `${username}-device` }
  })
  return res.json().data.accessToken
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

async function setup(): Promise<{
  db: DB
  app: FastifyInstance
  orgScope: string
  aliceId: string
}> {
  const db = openDb({ path: ':memory:' })
  const orgScope = ensureOrgScope(db)
  await createUser(db, {
    username: 'admin',
    password: 'admin-password',
    role: 'admin',
    clearance: 2
  })
  const alice = await createUser(db, { username: 'alice', password: 'alice-password' })
  await createUser(db, { username: 'bob', password: 'bob-password' })
  return { db, app: buildApp({ db, cfg, serveWeb: false }), orgScope, aliceId: alice.id }
}

async function submit(
  app: FastifyInstance,
  token: string,
  scopeId: string,
  content: string
) {
  const request = multipartBody(
    { scopeId, title: '客户响应规范', tags: '客户,服务' },
    { name: 'service.md', content }
  )
  return app.inject({
    method: 'POST',
    url: '/api/v1/document-submissions',
    headers: { ...bearer(token), ...request.headers },
    payload: request.payload
  })
}

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'echo-document-submission-'))
  cfg = testConfig({ storageDir })
})

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true })
})

describe('文档个人/组织发布流', () => {
  it('员工上传到个人云空间时直接摄取，且其他人不可见', async () => {
    const { db, app, aliceId } = await setup()
    const aliceToken = await login(app, 'alice', 'alice-password')
    const bobToken = await login(app, 'bob', 'bob-password')
    const personalScope = `personal-${aliceId}`

    const res = await submit(
      app,
      aliceToken,
      personalScope,
      '# 个人备忘\n\n私人项目代号为星河七号。'
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().data.state).toBe('approved')
    expect(res.json().data.docId).toBeTruthy()
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const mine = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(aliceToken),
      payload: { query: '星河七号' }
    })
    expect(mine.json().data.chunks.length).toBeGreaterThan(0)
    expect(mine.json().data.chunks[0].scopeKind).toBe('personal')

    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(bobToken),
      payload: { query: '星河七号' }
    })
    expect(other.json().data.chunks).toHaveLength(0)
  })

  it('员工上传到公司空间先待审，通过并摄取后全组织可检索', async () => {
    const { db, app, orgScope } = await setup()
    const aliceToken = await login(app, 'alice', 'alice-password')
    const adminToken = await login(app, 'admin', 'admin-password')
    const bobToken = await login(app, 'bob', 'bob-password')

    const submitted = await submit(
      app,
      aliceToken,
      orgScope,
      '# 客户响应规范\n\nP1 故障必须在十五分钟内首次响应。'
    )
    expect(submitted.json().data.state).toBe('pending')
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toMatchObject({ n: 0 })
    const submissionId = submitted.json().data.submissionId

    const memberReviewDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/document-submissions/${submissionId}/raw`,
      headers: bearer(bobToken)
    })
    expect(memberReviewDownload.statusCode).toBe(403)
    const reviewerDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/document-submissions/${submissionId}/raw`,
      headers: bearer(adminToken)
    })
    expect(reviewerDownload.statusCode).toBe(200)
    expect(reviewerDownload.body).toContain('P1 故障')

    const before = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(bobToken),
      payload: { query: 'P1 故障首次响应' }
    })
    expect(before.json().data.chunks).toHaveLength(0)

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/document-submissions/${submissionId}/approve`,
      headers: bearer(adminToken),
      payload: { note: '内容已校验' }
    })
    expect(approved.statusCode).toBe(200)
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(bobToken),
      payload: { query: 'P1 故障首次响应' }
    })
    expect(after.json().data.chunks.length).toBeGreaterThan(0)
    expect(after.json().data.chunks[0].docTitle).toBe('客户响应规范')
  })

  it('个人文档可以发布副本到组织，审核前后的可见性立即切换', async () => {
    const { db, app, orgScope, aliceId } = await setup()
    const aliceToken = await login(app, 'alice', 'alice-password')
    const adminToken = await login(app, 'admin', 'admin-password')
    const bobToken = await login(app, 'bob', 'bob-password')
    const personal = await submit(
      app,
      aliceToken,
      `personal-${aliceId}`,
      '# 个人经验\n\n蓝海客户的紧急响应口令为珊瑚七号。'
    )
    await drain({ db, cfg, embedder: createEmbedder(cfg) })
    const sourceDocId = personal.json().data.docId

    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${sourceDocId}/publish`,
      headers: bearer(aliceToken),
      payload: { targetScopeId: orgScope, title: '蓝海客户应急手册' }
    })
    expect(published.statusCode).toBe(200)
    expect(published.json().data.state).toBe('pending')

    const before = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(bobToken),
      payload: { query: '珊瑚七号' }
    })
    expect(before.json().data.chunks).toHaveLength(0)

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/document-submissions/${published.json().data.submissionId}/approve`,
      headers: bearer(adminToken),
      payload: { note: '可发布' }
    })
    expect(approved.statusCode).toBe(200)
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(bobToken),
      payload: { query: '珊瑚七号' }
    })
    expect(after.json().data.chunks.some((chunk: { docTitle: string }) =>
      chunk.docTitle === '蓝海客户应急手册')).toBe(true)
  })

  it('个人文档所有者可上传新版本并归档，归档后新内容立即退出检索', async () => {
    const { db, app, aliceId } = await setup()
    const aliceToken = await login(app, 'alice', 'alice-password')
    const personal = await submit(
      app,
      aliceToken,
      `personal-${aliceId}`,
      '# 客户备忘\n\n初版响应代号为星云一号。'
    )
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const versionBody = multipartBody(
      { title: '客户备忘 v2' },
      { name: 'service.md', content: '# 客户备忘\n\n新版响应代号为星云二号。' }
    )
    const version = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${personal.json().data.docId}/new-version`,
      headers: { ...bearer(aliceToken), ...versionBody.headers },
      payload: versionBody.payload
    })
    expect(version.statusCode).toBe(200)
    expect(version.json().data.version).toBe(2)
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const beforeArchive = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(aliceToken),
      payload: { query: '星云二号' }
    })
    expect(beforeArchive.json().data.chunks.length).toBeGreaterThan(0)

    const archived = await app.inject({
      method: 'DELETE',
      url: `/api/v1/docs/${version.json().data.docId}`,
      headers: bearer(aliceToken)
    })
    expect(archived.statusCode).toBe(200)
    expect(archived.json().data.archived).toBe(true)
    const afterArchive = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(aliceToken),
      payload: { query: '星云二号' }
    })
    expect(afterArchive.json().data.chunks).toHaveLength(0)
  })
})
