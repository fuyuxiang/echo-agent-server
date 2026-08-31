import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { verifyServerPayload } from '../src/server-signing.js'

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
  vi.unstubAllGlobals()
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

  it('企业策略只能由管理员更新，新版本签名会在 bootstrap 立即生效', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/enterprise-policy',
      headers: bearer(aliceToken)
    })
    expect(denied.statusCode).toBe(403)

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/enterprise-policy',
      headers: bearer(adminToken)
    })
    const previousVersion = before.json().data.version
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/enterprise-policy',
      headers: bearer(adminToken),
      payload: {
        allowLocalKnowledge: false,
        allowPersonalCloud: false,
        allowSkillSubmission: false,
        offlineEnterpriseContent: false,
        managedSkillLeaseHours: 6
      }
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().data.version).toBe(previousVersion + 1)

    const bootstrap = await app.inject({
      method: 'GET',
      url: '/api/v1/client/bootstrap',
      headers: bearer(aliceToken)
    })
    const data = bootstrap.json().data
    expect(data.policy).toMatchObject({
      version: previousVersion + 1,
      allowLocalKnowledge: false,
      allowPersonalCloud: false,
      allowSkillSubmission: false,
      offlineEnterpriseContent: false,
      managedSkillLeaseHours: 6
    })
    expect(
      verifyServerPayload(data.signingPublicKey, data.policyPayload, data.policySignature)
    ).toBe(true)
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

  it('取无页码引用原文时兼容旧客户端发送的 page:null', async () => {
    const upload = multipartBody(
      orgScope,
      '# 无页码制度\n\n这是一份没有页码信息的 Markdown 制度原文。'
    )
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/docs/upload',
      headers: { ...bearer(adminToken), 'content-type': upload.contentType },
      payload: upload.payload
    })
    const docId = uploaded.json().data.docId as string
    await drain({ db, cfg: app.deps.cfg, embedder: createEmbedder(app.deps.cfg) })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/docs/fetch',
      headers: bearer(adminToken),
      payload: { docId, page: null }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.text).toContain('没有页码信息')
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

  it('模型规划按证据缺口补检，并对完整 chunk 做逐 claim 语义校验', async () => {
    const askedQueries: string[] = []
    const longMaterial = `材料说明：${'背景信息'.repeat(400)}申请材料包括身份证和审批表。`
    const makeChunk = (
      chunkId: string,
      docId: string,
      title: string,
      text: string,
      score: number
    ) => ({
      chunkId,
      docId,
      docTitle: title,
      text,
      score,
      scopeKind: 'org',
      modality: 'text',
      sourceType: 'markdown',
      source: 'L3' as const,
      citation: {
        page: 1,
        heading: title,
        startMs: null,
        endMs: null,
        openUrl: `echo://doc/${docId}/page/1`
      },
      owner: null,
      stale: false,
      updatedAt: Date.now()
    })
    const agentRetriever = {
      retrieve: async (_userId: string, request: { query: string }) => {
        askedQueries.push(request.query)
        const chunks = request.query.includes('申请需要哪些材料')
          ? [makeChunk('c-material', 'd-material', '采购申请材料', longMaterial, 0.94)]
          : [makeChunk('c-approval', 'd-approval', '采购审批制度', '采购申请至少需要两级审批。', 0.96)]
        return {
          chunks,
          memories: [],
          diagnostics: {
            bm25Hits: 1,
            vecHits: 1,
            fusedCandidates: 1,
            rerankMs: 5,
            rerankSkipped: false,
            totalMs: 10
          }
        }
      }
    } as unknown as Retriever

    await app.close()
    const agentCfg = testConfig({
      storageDir,
      chatModel: 'agent-reasoner',
      chatBaseUrl: 'https://chat.test/v1',
      chatKey: 'server-secret'
    })
    app = buildApp({
      db,
      cfg: agentCfg,
      serveWeb: false,
      overrides: { retriever: agentRetriever }
    })
    aliceToken = await login('alice', 'alice-password')

    let assessmentCalls = 0
    let generationEvidence = ''
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
      }
      const system = body.messages[0]!.content
      const user = body.messages[1]!.content
      let content: unknown
      if (system.includes('企业知识检索规划器')) {
        content = {
          mode: 'deep',
          intent: 'multi_hop',
          subQueries: ['完成采购申请需要几级审批以及提交哪些材料？'],
          requiredFacts: ['审批级数', '申请材料']
        }
      } else if (system.includes('证据覆盖审查器')) {
        assessmentCalls++
        content = assessmentCalls === 1
          ? {
              sufficient: false,
              confidence: 0.7,
              coveredFacts: ['审批级数'],
              missingFacts: ['申请材料'],
              followUpQueries: ['申请需要哪些材料']
            }
          : {
              sufficient: true,
              confidence: 0.93,
              coveredFacts: ['审批级数', '申请材料'],
              missingFacts: [],
              followUpQueries: []
            }
      } else if (system.includes('企业知识问答器')) {
        generationEvidence = user
        content = {
          insufficient: false,
          claims: [
            { text: '采购申请至少需要两级审批。', citationIds: ['cit-1'] },
            { text: '申请材料包括身份证和审批表。', citationIds: ['cit-2'] }
          ]
        }
      } else if (system.includes('事实蕴含审查器')) {
        content = {
          answerComplete: true,
          missingRequiredFacts: [],
          verdicts: [
            { claimIndex: 0, verdict: 'supported', reason: '' },
            { claimIndex: 1, verdict: 'supported', reason: '' }
          ]
        }
      } else {
        throw new Error(`意外的模型调用: ${system}`)
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/ask',
      headers: bearer(aliceToken),
      payload: { question: '完成采购申请需要几级审批以及提交哪些材料？', mode: 'auto' }
    })
    const parsed = events(response.body)
    const final = parsed.get('final')?.[0] as {
      answer: string
      insufficient: boolean
      verification: string
      claims: Array<{ text: string; citationIds: string[] }>
      agentic: { planner: string; assessor: string; rounds: number; queries: number }
    }
    expect(final.insufficient).toBe(false)
    expect(final.verification).toBe('supported')
    expect(final.claims).toHaveLength(2)
    expect(final.answer).toContain('两级审批')
    expect(final.answer).toContain('[cit-2]')
    expect(final.agentic).toMatchObject({
      planner: 'model',
      assessor: 'model',
      rounds: 2,
      queries: 2
    })
    expect(askedQueries).toEqual([
      '完成采购申请需要几级审批以及提交哪些材料？',
      '申请需要哪些材料'
    ])
    // 关键事实位于 1200 字 UI quote 之后；生成模型必须看到完整 chunk。
    expect(generationEvidence).toContain('申请材料包括身份证和审批表')
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
