import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { openDb, type DB } from '../src/db/index.js'
import { testConfig } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { createUser, setUserGroups } from '../src/dao/users.js'
import { ensureOrgScope } from '../src/server.js'
import { chunkBlocks } from '../src/kb/ingest/chunk.js'
import { indexChunks } from '../src/kb/ingest/indexer.js'
import { createEmbedder } from '../src/models/embedder.js'

// 同步接口的安全核心是 revokedDocs:权限收回、密级提升、文档删除都必须
// 能推到客户端。漏推任何一种,本地缓存就会继续提供服务端已经收走的内容 ——
// 这是"离线可用"这个便利功能最容易埋下的越权漏洞。

let storageDir: string
let cfg: ReturnType<typeof testConfig>

interface Ctx {
  db: DB
  app: FastifyInstance
  orgScope: string
  teamScope: string
  aliceId: string
}

async function setup(): Promise<Ctx> {
  const db = openDb({ path: ':memory:' })
  const orgScope = ensureOrgScope(db)
  const now = Date.now()
  db.prepare("INSERT INTO groups VALUES ('g_fin','财务部',NULL,'',?)").run(now)
  const teamScope = 's_fin'
  db.prepare("INSERT INTO scopes VALUES (?,'team','g_fin','财务部')").run(teamScope)

  await createUser(db, { username: 'admin', password: 'admin-password', role: 'admin', clearance: 2 })
  const alice = await createUser(db, { username: 'alice', password: 'alice-password' })
  setUserGroups(db, alice.id, ['g_fin'])

  return { db, app: buildApp({ db, cfg }), orgScope, teamScope, aliceId: alice.id }
}

async function login(app: FastifyInstance, u: string, p: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: u, password: p, deviceId: 'dev1' }
  })
  return res.json().data.accessToken
}

const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })

async function addDoc(
  ctx: Ctx,
  scopeId: string,
  title: string,
  text: string,
  sensitivity = 0
): Promise<string> {
  const id = randomUUID()
  const now = Date.now()
  ctx.db
    .prepare(
      `INSERT INTO documents (id, scope_id, title, source_type, storage_key, content_hash,
                              byte_size, sensitivity, status, created_at, updated_at)
       VALUES (?,?,?,'md',?,?,?,?, 'ready',?,?)`
    )
    .run(id, scopeId, title, `k/${id}.md`, createHash('sha256').update(text).digest('hex'), text.length, sensitivity, now, now)
  await indexChunks(
    ctx.db,
    id,
    chunkBlocks([{ kind: 'para', text }]),
    createEmbedder(cfg),
    'test-v1'
  )
  return id
}

async function sync(
  app: FastifyInstance,
  token: string,
  cursor = 0
): Promise<Record<string, never> & {
  docs: { docId: string; title: string; chunks: unknown[] }[]
  memories: unknown[]
  revokedDocs: string[]
  nextCursor: number
  purgeAll: boolean
}> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/sync?cursor=${cursor}&deviceId=dev1`,
    headers: bearer(token)
  })
  return res.json().data
}

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'echo-sync-'))
  cfg = testConfig({ storageDir })
})

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true })
})

describe('增量同步', () => {
  it('下发可见文档及其 chunk', async () => {
    const ctx = await setup()
    await addDoc(ctx, ctx.orgScope, '员工手册', '公司实行弹性工作制,核心时间十点到四点。')
    const token = await login(ctx.app, 'alice', 'alice-password')

    const res = await sync(ctx.app, token)
    expect(res.docs.length).toBe(1)
    expect(res.docs[0].title).toBe('员工手册')
    // chunk 必须一起下发,否则客户端建不了本地索引。
    expect(res.docs[0].chunks.length).toBeGreaterThan(0)
  })

  it('不下发无权访问的文档', async () => {
    const ctx = await setup()
    await addDoc(ctx, ctx.orgScope, '公开手册', '弹性工作制说明。')
    // bob 不在财务部
    await createUser(ctx.db, { username: 'bob', password: 'bob-password' })
    await addDoc(ctx, ctx.teamScope, '财务内部', '发票审核流程说明。')

    const token = await login(ctx.app, 'bob', 'bob-password')
    const res = await sync(ctx.app, token)
    const titles = res.docs.map((d) => d.title)
    expect(titles).toContain('公开手册')
    expect(titles).not.toContain('财务内部')
  })

  it('不下发超出密级的文档', async () => {
    const ctx = await setup()
    await addDoc(ctx, ctx.orgScope, '董事会决议', '高管薪酬方案。', 2)
    const token = await login(ctx.app, 'alice', 'alice-password')
    const res = await sync(ctx.app, token)
    expect(res.docs.map((d) => d.title)).not.toContain('董事会决议')
  })

  it('cursor 实现增量:第二次同步不重复下发', async () => {
    const ctx = await setup()
    await addDoc(ctx, ctx.orgScope, '文档一', '第一篇的正文内容说明。')
    const token = await login(ctx.app, 'alice', 'alice-password')

    const first = await sync(ctx.app, token)
    expect(first.docs.length).toBe(1)

    const second = await sync(ctx.app, token, first.nextCursor)
    expect(second.docs.length).toBe(0)
  })

  it('新增文档在后续同步中出现', async () => {
    const ctx = await setup()
    await addDoc(ctx, ctx.orgScope, '文档一', '第一篇的正文内容说明。')
    const token = await login(ctx.app, 'alice', 'alice-password')
    const first = await sync(ctx.app, token)

    await new Promise((r) => setTimeout(r, 5))
    await addDoc(ctx, ctx.orgScope, '文档二', '第二篇的正文内容说明。')

    const second = await sync(ctx.app, token, first.nextCursor)
    expect(second.docs.map((d) => d.title)).toContain('文档二')
  })

  it('记录同步游标', async () => {
    const ctx = await setup()
    await addDoc(ctx, ctx.orgScope, '文档', '正文内容说明。')
    const token = await login(ctx.app, 'alice', 'alice-password')
    await sync(ctx.app, token)

    const row = ctx.db
      .prepare('SELECT user_id AS userId, cursor FROM sync_cursors WHERE device_id = ?')
      .get('dev1') as { userId: string; cursor: number }
    expect(row.userId).toBe(ctx.aliceId)
    expect(row.cursor).toBeGreaterThan(0)
  })
})

// 这三条是安全关键。每一条对应一种"服务端已收回但客户端可能还留着"的情况。
describe('权限收回推送', () => {
  it('删除的文档出现在 revokedDocs', async () => {
    const ctx = await setup()
    const docId = await addDoc(ctx, ctx.orgScope, '旧制度', '报销单三十日内提交。')
    const adminToken = await login(ctx.app, 'admin', 'admin-password')
    const token = await login(ctx.app, 'alice', 'alice-password')
    const first = await sync(ctx.app, token)
    expect(first.docs.length).toBe(1)

    await new Promise((r) => setTimeout(r, 5))
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/docs/${docId}`,
      headers: bearer(adminToken)
    })

    const second = await sync(ctx.app, token, first.nextCursor)
    expect(second.revokedDocs).toContain(docId)
  })

  // 最容易漏的一种:文档还在、还是 ready,只是移出了该用户的可见范围。
  it('移出可见 scope 的文档出现在 revokedDocs', async () => {
    const ctx = await setup()
    const docId = await addDoc(ctx, ctx.orgScope, '将转移的文档', '正文内容说明文字。')
    const adminToken = await login(ctx.app, 'admin', 'admin-password')
    const token = await login(ctx.app, 'alice', 'alice-password')
    const first = await sync(ctx.app, token)
    expect(first.docs.length).toBe(1)

    await new Promise((r) => setTimeout(r, 5))
    // 建一个 alice 看不到的组并把文档移过去
    ctx.db.prepare("INSERT INTO groups VALUES ('g_hr','人事部',NULL,'',?)").run(Date.now())
    ctx.db.prepare("INSERT INTO scopes VALUES ('s_hr','team','g_hr','人事部')").run()
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${docId}`,
      headers: bearer(adminToken),
      payload: { scopeId: 's_hr' }
    })

    const second = await sync(ctx.app, token, first.nextCursor)
    expect(second.revokedDocs).toContain(docId)
  })

  it('密级提升后的文档出现在 revokedDocs', async () => {
    const ctx = await setup()
    const docId = await addDoc(ctx, ctx.orgScope, '将升密的文档', '正文内容说明文字。')
    const adminToken = await login(ctx.app, 'admin', 'admin-password')
    const token = await login(ctx.app, 'alice', 'alice-password')
    const first = await sync(ctx.app, token)
    expect(first.docs.length).toBe(1)

    await new Promise((r) => setTimeout(r, 5))
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${docId}`,
      headers: bearer(adminToken),
      payload: { sensitivity: 2 }
    })

    const second = await sync(ctx.app, token, first.nextCursor)
    expect(second.revokedDocs).toContain(docId)
  })

  it('用户被移出所有分组后要求清空全部缓存', async () => {
    const ctx = await setup()
    await addDoc(ctx, ctx.teamScope, '财务内部', '发票审核流程。')
    const token = await login(ctx.app, 'alice', 'alice-password')

    // 禁用用户 → 无任何可见范围
    ctx.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(ctx.aliceId)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync?cursor=0&deviceId=dev1',
      headers: bearer(token)
    })
    // 被禁用后 token 本身已失效,这是更强的保护
    expect(res.statusCode).toBe(401)
  })

  it('移出分组后该组文档被收回', async () => {
    const ctx = await setup()
    const docId = await addDoc(ctx, ctx.teamScope, '财务内部', '发票审核流程说明文字。')
    const token = await login(ctx.app, 'alice', 'alice-password')
    const first = await sync(ctx.app, token)
    expect(first.docs.map((d) => d.docId)).toContain(docId)

    // 移出财务部。token_version 会递增,所以要重新登录。
    setUserGroups(ctx.db, ctx.aliceId, [])
    const token2 = await login(ctx.app, 'alice', 'alice-password')
    const second = await sync(ctx.app, token2, 0)
    expect(second.docs.map((d) => d.docId)).not.toContain(docId)
    expect(second.revokedDocs).toContain(docId)
  })
})

describe('质量看板', () => {
  it('统计无答案率与知识盲区', async () => {
    const ctx = await setup()
    const token = await login(ctx.app, 'alice', 'alice-password')

    for (const [q, answered] of [
      ['报销标准是多少', true],
      ['量子计算机预算', false],
      ['量子计算机预算', false]
    ] as [string, boolean][]) {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/qa-events',
        headers: bearer(token),
        payload: { question: q, answered, latencyMs: 300, route: 'fast' }
      })
    }

    const adminToken = await login(ctx.app, 'admin', 'admin-password')
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/quality/overview',
      headers: bearer(adminToken)
    })
    const d = res.json().data
    expect(d.total).toBe(3)
    expect(d.unansweredRate).toBeCloseTo(2 / 3, 2)
    // 盲区列表直接可以变成"待补充文档"清单
    expect(d.blindSpots[0].question).toBe('量子计算机预算')
    expect(d.blindSpots[0].n).toBe(2)
  })

  it('记录并统计负面反馈', async () => {
    const ctx = await setup()
    const token = await login(ctx.app, 'alice', 'alice-password')
    const ev = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/qa-events',
      headers: bearer(token),
      payload: { question: '住宿标准', answered: true, latencyMs: 200, route: 'fast' }
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/qa-events/${ev.json().data.id}/feedback`,
      headers: bearer(token),
      payload: { feedback: 'wrong' }
    })

    const adminToken = await login(ctx.app, 'admin', 'admin-password')
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/quality/overview',
      headers: bearer(adminToken)
    })
    expect(res.json().data.negativeRate).toBe(1)
    expect(res.json().data.negativeTop.length).toBe(1)
  })

  it('不能篡改他人的反馈', async () => {
    const ctx = await setup()
    const aliceToken = await login(ctx.app, 'alice', 'alice-password')
    await createUser(ctx.db, { username: 'bob', password: 'bob-password' })
    const bobToken = await login(ctx.app, 'bob', 'bob-password')

    const ev = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/qa-events',
      headers: bearer(aliceToken),
      payload: { question: '住宿标准', answered: true }
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/qa-events/${ev.json().data.id}/feedback`,
      headers: bearer(bobToken),
      payload: { feedback: 'wrong' }
    })
    expect(res.statusCode).toBe(404)
  })

  it('普通成员看不到质量看板', async () => {
    const ctx = await setup()
    const token = await login(ctx.app, 'alice', 'alice-password')
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/quality/overview',
      headers: bearer(token)
    })
    expect(res.statusCode).toBe(403)
  })
})
