import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { testConfig } from '../src/config.js'
import { createUser } from '../src/dao/users.js'
import { openDb, type DB } from '../src/db/index.js'
import { drain } from '../src/kb/ingest/worker.js'
import { createEmbedder } from '../src/models/embedder.js'
import { ensureOrgScope } from '../src/server.js'
import type { Retriever } from '../src/kb/retrieve/index.js'

let db: DB
let app: FastifyInstance
let storageDir: string
let orgScope: string
let adminToken: string
let aliceToken: string

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

function multipartBody(scopeId: string, content: string) {
  const boundary = '----EchoAskBoundary123'
  return {
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="scopeId"\r\n\r\n${scopeId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n差旅制度\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="travel.md"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${content}\r\n` +
      `--${boundary}--\r\n`,
      'utf8'
    ),
    contentType: `multipart/form-data; boundary=${boundary}`
  }
}

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, deviceId: `${username}-ask` }
  })
  return response.json().data.accessToken
}

function events(body: string): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>()
  for (const block of body.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (!event || !data) continue
    const values = result.get(event) ?? []
    values.push(JSON.parse(data))
    result.set(event, values)
  }
  return result
}

beforeEach(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'echo-ask-'))
  const cfg = testConfig({ storageDir })
  db = openDb({ path: ':memory:' })
  orgScope = ensureOrgScope(db)
  await createUser(db, {
    username: 'admin',
    password: 'admin-password',
    role: 'admin',
    clearance: 2
  })
  await createUser(db, { username: 'alice', password: 'alice-password' })
  app = buildApp({ db, cfg, serveWeb: false })
  adminToken = await login('admin', 'admin-password')
  aliceToken = await login('alice', 'alice-password')
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(storageDir, { recursive: true, force: true })
})

describe('桌面端启动与 Agentic RAG', () => {
  it('bootstrap 返回当前用户、个人/组织 scope 和签名策略', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/bootstrap',
      headers: bearer(aliceToken)
    })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.user.username).toBe('alice')
    expect(data.scopes.map((scope: { kind: string }) => scope.kind)).toEqual(['personal', 'org'])
    expect(data.policy.allowPersonalCloud).toBe(true)
    expect(data.policySignature).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(data.endpoints.ask).toBe('/api/v1/knowledge/ask')
  })

  it('有证据时返回 SSE 结构化引用，没配大模型仍有可用的抽取式降级', async () => {
    const upload = multipartBody(
      orgScope,
      '# 差旅住宿\n\n一线城市住宿上限为每晚五百元，其他城市为三百五十元。'
    )
    await app.inject({
      method: 'POST',
      url: '/api/v1/docs/upload',
      headers: { ...bearer(adminToken), 'content-type': upload.contentType },
      payload: upload.payload
    })
    await drain({ db, cfg: app.deps.cfg, embedder: createEmbedder(app.deps.cfg) })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/ask',
      headers: bearer(aliceToken),
      payload: { question: '一线城市住宿标准是多少？', mode: 'auto' }
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    const parsed = events(response.body)
    expect(parsed.has('meta')).toBe(true)
    expect(parsed.has('citation')).toBe(true)
    const final = parsed.get('final')?.[0] as {
      answer: string
      insufficient: boolean
      citations: Array<{ docId: string; chunkId: string; quote: string }>
      verification: string
    }
    expect(final.insufficient).toBe(false)
    expect(final.answer).toContain('[cit-1]')
    expect(final.citations[0].docId).toBeTruthy()
    expect(final.citations[0].chunkId).toBeTruthy()
    expect(final.citations[0].quote).toContain('五百元')
    expect(final.verification).toBe('extractive_fallback')
    expect(db.prepare('SELECT COUNT(*) AS n FROM qa_events').get()).toMatchObject({ n: 1 })
  })

  it('没有授权内证据时明确拒答', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/ask',
      headers: bearer(aliceToken),
      payload: { question: '公司月球基地的采购预算是多少？' }
    })
    const final = events(response.body).get('final')?.[0] as {
      insufficient: boolean
      citations: unknown[]
    }
    expect(final.insufficient).toBe(true)
    expect(final.citations).toHaveLength(0)
  })

  it('检索完成前就刷出 SSE 状态，客户端可以取消慢请求', async () => {
    let releaseRetrieve = () => undefined
    const retrieveGate = new Promise<void>((resolve) => { releaseRetrieve = resolve })
    const slowRetriever = {
      retrieve: async () => {
        await retrieveGate
        return {
          chunks: [],
          memories: [],
          diagnostics: {
            bm25Hits: 0,
            vecHits: 0,
            fusedCandidates: 0,
            rerankMs: 0,
            rerankSkipped: false,
            totalMs: 0
          }
        }
      }
    } as unknown as Retriever

    await app.close()
    app = buildApp({
      db,
      cfg: app.deps.cfg,
      serveWeb: false,
      overrides: { retriever: slowRetriever }
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器未监听 TCP 端口')

    let timeout: NodeJS.Timeout | undefined
    try {
      const response = await Promise.race([
        fetch(`http://127.0.0.1:${address.port}/api/v1/knowledge/ask`, {
          method: 'POST',
          headers: { ...bearer(aliceToken), 'content-type': 'application/json' },
          body: JSON.stringify({ question: '这是一个慢检索吗？' })
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('SSE 首响应等待了检索完成')), 2000)
        })
      ])
      if (timeout) clearTimeout(timeout)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const reader = response.body!.getReader()
      const first = await reader.read()
      const text = new TextDecoder().decode(first.value)
      expect(text).toContain('event: meta')
      expect(text).toContain('event: status')
      expect(text).toContain('retrieving')
      await reader.cancel()
    } finally {
      if (timeout) clearTimeout(timeout)
      releaseRetrieve()
    }
  })
})
