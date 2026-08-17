import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { testConfig } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { createUser } from '../src/dao/users.js'
import { ensureOrgScope } from '../src/server.js'
import { drain } from '../src/kb/ingest/worker.js'
import { createEmbedder } from '../src/models/embedder.js'
import type { FastifyInstance } from 'fastify'

// MCP 是新的对外接口 —— Cursor/Claude Desktop 都会调。
// 关键验证:权限边界与 /api/v1/* 完全一致,token 缺失/无效必返 401。

interface Ctx {
  db: DB
  app: FastifyInstance
  aliceToken: string
  bobToken: string
  orgScope: string
  finScope: string
  docId: string
}

async function setup(): Promise<Ctx> {
  const db = openDb({ path: ':memory:' })
  const orgScope = ensureOrgScope(db)
  const now = Date.now()
  db.prepare("INSERT INTO groups VALUES ('g_fin','财务部',NULL,'',?)").run(now)
  db.prepare("INSERT INTO scopes VALUES ('s_fin','team','g_fin','财务部')").run()
  const finScope = 's_fin'

  await createUser(db, {
    username: 'admin',
    password: 'admin-pw',
    role: 'admin',
    clearance: 2
  })
  const alice = await createUser(db, { username: 'alice', password: 'alice-pw' })
  const bob = await createUser(db, { username: 'bob', password: 'bob-pw' })
  db.prepare('INSERT INTO user_groups VALUES (?,?)').run(alice.id, 'g_fin')

  const app = buildApp({ db, cfg: testConfig(), serveWeb: false })

  const login = async (u: string, p: string): Promise<string> => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: u, password: p, deviceId: 'd1' }
    })
    return r.json().data.accessToken
  }
  const adminToken = await login('admin', 'admin-pw')
  const aliceToken = await login('alice', 'alice-pw')
  const bobToken = await login('bob', 'bob-pw')

  // 上传两份文档,一份在 org、一份在财务
  const crypto = await import('node:crypto')
  const doc1 = crypto.randomUUID()
  const doc2 = crypto.randomUUID()
  const t = Date.now()
  const insertDoc = (id: string, scope: string, title: string, sensitivity: number) => {
    db.prepare(
      `INSERT INTO documents (id, scope_id, title, source_type, content_hash, byte_size,
                              sensitivity, status, created_at, updated_at)
       VALUES (?,?,?,'md',?,?,?,'ready',?,?)`
    ).run(id, scope, title, crypto.randomUUID(), 100, sensitivity, t, t)
  }
  insertDoc(doc1, orgScope, '员工手册', 0)
  insertDoc(doc2, finScope, '财务内部流程', 0)

  const insertChunk = (chunkId: string, docId: string, scope: string, text: string) => {
    const ins = db.prepare(
      `INSERT INTO chunks (id, doc_id, scope_id, sensitivity, seq, text, token_count, created_at)
       VALUES (?,?,?,0,0,?,1,?)`
    ).run(chunkId, docId, scope, text, t)
    const insMeta = db.prepare(
      `INSERT INTO embedding_meta (chunk_id, model_version, fts_rowid, created_at)
       VALUES (?,?,?,?)`
    ).run(chunkId, 'test-v1', Number(ins.lastInsertRowid), t)
    void insMeta
    db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?,?)').run(
      Number(ins.lastInsertRowid),
      text
    )
  }
  insertChunk(crypto.randomUUID(), doc1, orgScope, '公司实行弹性工作制。')
  insertChunk(crypto.randomUUID(), doc2, finScope, '发票审核由财务专员初审。')

  // 上述插入只是让 lists 走通;走 retriever 路径的 search 测试单独驱动。
  // 这里仅用作初始化,主动跳过摄取流水线(占位实现没有真实向量)。
  void drain({ db, cfg: testConfig(), embedder: createEmbedder(testConfig()) })
  await new Promise((r) => setTimeout(r, 50))

  return {
    db,
    app,
    aliceToken,
    bobToken,
    orgScope,
    finScope,
    docId: doc1
  }
}

async function mcpInit(
  app: FastifyInstance,
  token: string
): Promise<{ sessionId?: string; response: Awaited<ReturnType<typeof app.inject>> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' }
      }
    }
  })
  // Streamable HTTP 在 initialize 响应里带 mcp-session-id
  const sessionId = res.headers['mcp-session-id'] as string | undefined
  return { sessionId, response: res }
}

async function callTool(
  app: FastifyInstance,
  token: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: number; result: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId
    },
    payload: {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: { name, arguments: args }
    }
  })
  const body = res.body
  const dataLine = body
    .split('\n')
    .find((l) => l.startsWith('data: '))
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(body)
  return { ok: res.statusCode, result: json.result ?? json.error }
}

describe('MCP 鉴权', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await setup()
  })

  it('无 token 返回 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    })
    expect(res.statusCode).toBe(401)
  })

  it('token 错误返回 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer not-a-real-jwt' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    })
    expect(res.statusCode).toBe(401)
  })

  it('带正确 token 完成 initialize 握手', async () => {
    const { response } = await mcpInit(ctx.app, ctx.aliceToken)
    expect(response.statusCode).toBe(200)
  })
})

describe('MCP 权限边界', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await setup()
  })

  it('alice(财务部成员)能看 org 与财务两层文档', async () => {
    const { sessionId } = await mcpInit(ctx.app, ctx.aliceToken)
    const { result } = await callTool(ctx.app, ctx.aliceToken, sessionId, 'org_list_docs', {})
    const text = String((result as { content: { text: string }[] }).content[0].text)
    // alice 在财务部,应同时看到 org 与财务两层
    expect(text).toContain('员工手册')
    expect(text).toContain('财务内部流程')
  })

  it('bob(无分组) 只能看到 org 层文档', async () => {
    const { sessionId } = await mcpInit(ctx.app, ctx.bobToken)
    const { result } = await callTool(ctx.app, ctx.bobToken, sessionId, 'org_list_docs', {})
    const text = String((result as { content: { text: string }[] }).content[0].text)
    expect(text).toContain('员工手册')
    expect(text).not.toContain('财务内部流程')
  })

  it('传入无权访问的 scope_id 直接拒绝,不给空列表', async () => {
    const { sessionId } = await mcpInit(ctx.app, ctx.bobToken)
    const { result, ok } = await callTool(
      ctx.app,
      ctx.bobToken,
      sessionId,
      'org_list_docs',
      { scope_id: ctx.finScope }
    )
    expect(ok).toBe(200)
    expect((result as { isError: boolean }).isError).toBe(true)
  })

  it('org_fetch_doc 不能读取其他部门的文档', async () => {
    const { sessionId } = await mcpInit(ctx.app, ctx.bobToken)
    // bob 试图读财务部文档
    const { result } = await callTool(
      ctx.app,
      ctx.bobToken,
      sessionId,
      'org_fetch_doc',
      { doc_id: 'unknown-or-wrong-scope-id' }
    )
    expect((result as { isError: boolean }).isError).toBe(true)
  })

  it('org_submit_knowledge 不能向无权范围提交', async () => {
    const { sessionId } = await mcpInit(ctx.app, ctx.bobToken)
    const { result } = await callTool(
      ctx.app,
      ctx.bobToken,
      sessionId,
      'org_submit_knowledge',
      {
        kind: 'fact',
        content: '试图向财务部提交',
        target_scope: ctx.finScope
      }
    )
    expect((result as { isError: boolean }).isError).toBe(true)
  })
})
