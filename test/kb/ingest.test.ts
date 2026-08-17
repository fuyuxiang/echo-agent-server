import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, type DB } from '../../src/db/index.js'
import { testConfig } from '../../src/config.js'
import { buildApp } from '../../src/app.js'
import { createUser } from '../../src/dao/users.js'
import { ensureOrgScope } from '../../src/server.js'
import { drain, enqueueIngest, backoffMs, LEASE_MS } from '../../src/kb/ingest/worker.js'
import { createEmbedder } from '../../src/models/embedder.js'

// 上传 → 摄取 → 检索的完整闭环。摄取是"静默失败"高发区:切坏了、
// 漏索引了都不报错,只是答案质量莫名变差。所以断言要落在"能不能查到"上。

let storageDir: string
let cfg: ReturnType<typeof testConfig>

async function setup(): Promise<{ db: DB; app: FastifyInstance; scopeId: string }> {
  const db = openDb({ path: ':memory:' })
  const scopeId = ensureOrgScope(db)
  await createUser(db, {
    username: 'admin',
    password: 'admin-password',
    role: 'admin',
    clearance: 2
  })
  await createUser(db, { username: 'alice', password: 'alice-password' })
  return { db, app: buildApp({ db, cfg, serveWeb: false }), scopeId }
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

/** 构造 multipart 请求体。Fastify inject 需要手写边界。 */
function multipartBody(
  fields: Record<string, string>,
  file: { name: string; content: string }
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----EchoTestBoundary1234567890'
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    )
  }
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

async function upload(
  app: FastifyInstance,
  token: string,
  scopeId: string,
  file: { name: string; content: string },
  extra: Record<string, string> = {}
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const { payload, headers } = multipartBody({ scopeId, ...extra }, file)
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/docs/upload',
    headers: { ...bearer(token), ...headers },
    payload
  })
  return { statusCode: res.statusCode, body: res.json().data ?? res.json() }
}

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'echo-storage-'))
  cfg = testConfig({ storageDir })
})

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true })
})

describe('上传', () => {
  it('接受 md 文件并入队摄取', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')

    const res = await upload(app, token, scopeId, {
      name: '差旅管理办法.md',
      content: '# 差旅管理办法\n\n## 住宿标准\n\n一线城市 500 元每晚。'
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.docId).toBeTruthy()
    expect(res.body.status).toBe('pending')

    const job = db
      .prepare('SELECT * FROM ingest_jobs WHERE doc_id = ?')
      .get(res.body.docId as string)
    expect(job).toBeTruthy()
  })

  it('相同内容在同 scope 内去重', async () => {
    const { app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const file = { name: 'a.md', content: '# 内容\n\n完全相同的正文。' }

    const first = await upload(app, token, scopeId, file)
    const second = await upload(app, token, scopeId, file)
    expect(second.body.dedup).toBe(true)
    expect(second.body.docId).toBe(first.body.docId)
  })

  it('拒绝不支持的文件类型', async () => {
    const { app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const res = await upload(app, token, scopeId, {
      name: 'evil.exe',
      content: 'MZ...'
    })
    expect(res.statusCode).toBe(415)
  })

  it('普通成员不能上传', async () => {
    const { app, scopeId } = await setup()
    const token = await login(app, 'alice', 'alice-password')
    const res = await upload(app, token, scopeId, { name: 'a.md', content: '# x' })
    expect(res.statusCode).toBe(403)
  })

  it('存储键不含原始文件名(防路径穿越)', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const res = await upload(app, token, scopeId, {
      name: '../../etc/passwd.md',
      content: '# x'
    })
    const key = db
      .prepare('SELECT storage_key AS k FROM documents WHERE id = ?')
      .get(res.body.docId as string) as { k: string }
    expect(key.k).not.toContain('..')
    expect(key.k).not.toContain('passwd')
  })
})

describe('摄取流水线', () => {
  it('走完四个阶段后文档变 ready 且可检索', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, {
      name: '差旅管理办法.md',
      content:
        '# 差旅管理办法\n\n## 住宿标准\n\n一线城市住宿标准为 500 元每晚,其他城市 350 元每晚。\n\n## 交通\n\n高铁二等座实报实销。'
    })
    const docId = up.body.docId as string

    const embedder = createEmbedder(cfg)
    const n = await drain({ db, cfg, embedder })
    expect(n).toBeGreaterThan(0)

    const doc = db
      .prepare('SELECT status, indexed_at AS indexedAt FROM documents WHERE id = ?')
      .get(docId) as { status: string; indexedAt: number | null }
    expect(doc.status).toBe('ready')
    expect(doc.indexedAt).toBeTruthy()

    const chunks = db
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?')
      .get(docId) as { n: number }
    expect(chunks.n).toBeGreaterThan(0)

    // 真正的验收:能不能查到。
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(token),
      payload: { query: '住宿标准' }
    })
    expect(res.statusCode).toBe(200)
    const hits = res.json().data.chunks
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].text).toContain('500')
  })

  it('Markdown 标题链被保留(提升召回)', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    await upload(app, token, scopeId, {
      name: 'h.md',
      content: '# 财务制度\n\n## 报销流程\n\n### 审批层级\n\n金额超过一万元需总监复核。'
    })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const chunk = db
      .prepare("SELECT heading FROM chunks WHERE text LIKE '%总监复核%' LIMIT 1")
      .get() as { heading: string } | undefined
    expect(chunk?.heading).toContain('财务制度')
    expect(chunk?.heading).toContain('审批层级')
  })

  it('Markdown 表格不被拆散', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    await upload(app, token, scopeId, {
      name: 't.md',
      content:
        '# 标准\n\n| 城市等级 | 住宿上限 |\n| --- | --- |\n| 一线 | 500 |\n| 二线 | 400 |\n| 三线 | 350 |'
    })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const row = db
      .prepare("SELECT text FROM chunks WHERE text LIKE '%一线%' LIMIT 1")
      .get() as { text: string } | undefined
    // 表头与数据行必须在同一 chunk,否则数字与列名脱钩。
    expect(row?.text).toContain('城市等级')
    expect(row?.text).toContain('500')
  })

  it('空文档被判为 failed 而非静默 ready', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, { name: 'empty.md', content: '   \n\n  ' })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const doc = db
      .prepare('SELECT status, fail_reason AS failReason FROM documents WHERE id = ?')
      .get(up.body.docId as string) as { status: string; failReason: string }
    expect(doc.status).toBe('failed')
    expect(doc.failReason).toContain('chunk')
  })

  it('重新索引会替换旧 chunk 而非叠加', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, {
      name: 'r.md',
      content: '# 制度\n\n原始内容说明文字。'
    })
    const docId = up.body.docId as string
    await drain({ db, cfg, embedder: createEmbedder(cfg) })
    const before = (
      db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?').get(docId) as {
        n: number
      }
    ).n

    enqueueIngest(db, docId)
    await drain({ db, cfg, embedder: createEmbedder(cfg) })
    const after = (
      db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?').get(docId) as {
        n: number
      }
    ).n
    expect(after).toBe(before)
  })

  it('超期租约被重新领取(进程重启不会卡死文档)', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, {
      name: 's.md',
      content: '# 制度\n\n正文内容。'
    })
    const docId = up.body.docId as string

    // 模拟 worker 领了任务后崩溃:running 且租约已过期
    db.prepare(
      "UPDATE ingest_jobs SET state='running', lease_until=? WHERE doc_id=?"
    ).run(Date.now() - LEASE_MS - 1000, docId)

    const n = await drain({ db, cfg, embedder: createEmbedder(cfg) })
    expect(n).toBeGreaterThan(0)
    const doc = db.prepare('SELECT status FROM documents WHERE id = ?').get(docId) as {
      status: string
    }
    expect(doc.status).toBe('ready')
  })

  it('未过期的租约不会被抢占', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, { name: 'l.md', content: '# x\n\n正文。' })

    db.prepare(
      "UPDATE ingest_jobs SET state='running', lease_until=? WHERE doc_id=?"
    ).run(Date.now() + LEASE_MS, up.body.docId as string)

    const n = await drain({ db, cfg, embedder: createEmbedder(cfg) })
    expect(n).toBe(0)
  })

  it('指数退避递增', () => {
    expect(backoffMs(0)).toBe(1000)
    expect(backoffMs(1)).toBe(4000)
    expect(backoffMs(2)).toBe(16000)
    expect(backoffMs(10)).toBeLessThanOrEqual(60000)
  })

  it('摄取途中删除文档不会让任务卡住', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, { name: 'd.md', content: '# x\n\n正文。' })
    db.prepare('DELETE FROM documents WHERE id = ?').run(up.body.docId as string)

    const n = await drain({ db, cfg, embedder: createEmbedder(cfg) })
    expect(n).toBeGreaterThanOrEqual(0)
  })
})

describe('文档路由', () => {
  it('状态接口反映摄取进度', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, { name: 'p.md', content: '# x\n\n正文内容。' })
    const docId = up.body.docId as string

    const pending = await app.inject({
      method: 'GET',
      url: `/api/v1/docs/${docId}/status`,
      headers: bearer(token)
    })
    expect(pending.statusCode).toBe(200)
    expect(pending.json().data.status).toBe('pending')

    await drain({ db, cfg, embedder: createEmbedder(cfg) })
    const ready = await app.inject({
      method: 'GET',
      url: `/api/v1/docs/${docId}/status`,
      headers: bearer(token)
    })
    expect(ready.json().data.status).toBe('ready')
    expect(ready.json().data.progress).toBe(1)
  })

  it('列表不含无权访问的文档', async () => {
    const { db, app, scopeId } = await setup()
    const adminToken = await login(app, 'admin', 'admin-password')

    // 建一个 alice 不属于的分组及其 scope
    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/groups',
      headers: bearer(adminToken),
      payload: { name: '财务部' }
    })
    const teamScope = groupRes.json().data.scopeId

    await upload(app, adminToken, teamScope, { name: 'fin.md', content: '# 财务\n\n内部资料。' })
    await upload(app, adminToken, scopeId, { name: 'pub.md', content: '# 公开\n\n员工手册。' })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const aliceToken = await login(app, 'alice', 'alice-password')
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/docs',
      headers: bearer(aliceToken)
    })
    const titles = res.json().data.items.map((d: { title: string }) => d.title)
    expect(titles).toContain('pub.md')
    expect(titles).not.toContain('fin.md')
  })

  it('高密级文档不出现在列表里(标题也会泄露信息)', async () => {
    const { db, app, scopeId } = await setup()
    const adminToken = await login(app, 'admin', 'admin-password')
    await upload(
      app,
      adminToken,
      scopeId,
      { name: '董事会薪酬决议.md', content: '# 决议\n\n机密内容。' },
      { sensitivity: '2' }
    )
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const aliceToken = await login(app, 'alice', 'alice-password')
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/docs',
      headers: bearer(aliceToken)
    })
    const titles = res.json().data.items.map((d: { title: string }) => d.title)
    expect(titles).not.toContain('董事会薪酬决议.md')
  })

  it('按 id 读取无权文档返回 404', async () => {
    const { db, app } = await setup()
    const adminToken = await login(app, 'admin', 'admin-password')
    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/groups',
      headers: bearer(adminToken),
      payload: { name: '财务部' }
    })
    const up = await upload(app, adminToken, groupRes.json().data.scopeId, {
      name: 'fin.md',
      content: '# 财务\n\n内部资料。'
    })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const aliceToken = await login(app, 'alice', 'alice-password')
    // 猜到 id 也不行 —— 按 id 的接口必须单独校验权限。
    for (const path of ['', '/status', '/raw']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/docs/${up.body.docId}${path}`,
        headers: bearer(aliceToken)
      })
      expect(res.statusCode).toBe(404)
    }
  })

  it('详情不回传内部存储路径', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, { name: 'x.md', content: '# x\n\n正文。' })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/docs/${up.body.docId}`,
      headers: bearer(token)
    })
    expect(JSON.stringify(res.json())).not.toContain('storage_key')
  })

  it('原始文件强制下载而非内联渲染', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, { name: 'x.md', content: '# x\n\n正文。' })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/docs/${up.body.docId}/raw`,
      headers: bearer(token)
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('软删后内容立即从检索消失', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, {
      name: 'old.md',
      content: '# 旧制度\n\n报销单需在三十日内提交。'
    })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const before = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(token),
      payload: { query: '报销单' }
    })
    expect(before.json().data.chunks.length).toBeGreaterThan(0)

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/docs/${up.body.docId}`,
      headers: bearer(token)
    })

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(token),
      payload: { query: '报销单' }
    })
    expect(after.json().data.chunks).toHaveLength(0)
    // 文档行保留为 archived,引用历史与审计仍可追溯。
    const doc = db
      .prepare('SELECT status FROM documents WHERE id = ?')
      .get(up.body.docId as string) as { status: string }
    expect(doc.status).toBe('archived')
  })

  // chunks 冗余了 scope_id/sensitivity 以免检索时 join。改文档权限时若不同步
  // 这两列,权限变更对已索引内容就会失效 —— 这是最容易漏的一处。
  it('改文档 scope 后 chunk 权限同步生效', async () => {
    const { db, app, scopeId } = await setup()
    const adminToken = await login(app, 'admin', 'admin-password')
    const up = await upload(app, adminToken, scopeId, {
      name: 'move.md',
      content: '# 内容\n\n即将转为受限的资料。'
    })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const aliceToken = await login(app, 'alice', 'alice-password')
    const before = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(aliceToken),
      payload: { query: '受限的资料' }
    })
    expect(before.json().data.chunks.length).toBeGreaterThan(0)

    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/groups',
      headers: bearer(adminToken),
      payload: { name: '财务部' }
    })
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${up.body.docId}`,
      headers: bearer(adminToken),
      payload: { scopeId: groupRes.json().data.scopeId }
    })

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(aliceToken),
      payload: { query: '受限的资料' }
    })
    expect(after.json().data.chunks).toHaveLength(0)
  })

  it('提高密级后立即对低权限用户不可见', async () => {
    const { db, app, scopeId } = await setup()
    const adminToken = await login(app, 'admin', 'admin-password')
    const up = await upload(app, adminToken, scopeId, {
      name: 'sec.md',
      content: '# 内容\n\n将要升密的段落文字。'
    })
    await drain({ db, cfg, embedder: createEmbedder(cfg) })

    const aliceToken = await login(app, 'alice', 'alice-password')
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${up.body.docId}`,
      headers: bearer(adminToken),
      payload: { sensitivity: 2 }
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieve',
      headers: bearer(aliceToken),
      payload: { query: '升密的段落' }
    })
    expect(res.json().data.chunks).toHaveLength(0)
  })
})

// server.ts 曾经忘记实例化 IngestWorker:上传成功但文档永远停在 pending,
// 且没有任何报错。单测里都是手动 drain() 所以测不出来 —— 这条守住"进程
// 真的会自己推进摄取"。
describe('IngestWorker 自动推进', () => {
  it('start() 后无需手动 drain 也能完成摄取', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const up = await upload(app, token, scopeId, {
      name: 'auto.md',
      content: '# 制度\n\n自动摄取的正文内容说明。'
    })
    const docId = up.body.docId as string

    const { IngestWorker } = await import('../../src/kb/ingest/worker.js')
    const worker = new IngestWorker({ db, cfg, embedder: createEmbedder(cfg) }, 20)
    worker.start()
    try {
      const deadline = Date.now() + 5000
      let status = ''
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
        status = (
          db.prepare('SELECT status FROM documents WHERE id = ?').get(docId) as {
            status: string
          }
        ).status
        if (status === 'ready' || status === 'failed') break
      }
      expect(status).toBe('ready')
    } finally {
      worker.stop()
    }
  })

  it('stop() 后不再推进新任务', async () => {
    const { db, app, scopeId } = await setup()
    const token = await login(app, 'admin', 'admin-password')
    const { IngestWorker } = await import('../../src/kb/ingest/worker.js')
    const worker = new IngestWorker({ db, cfg, embedder: createEmbedder(cfg) }, 20)
    worker.start()
    worker.stop()

    const up = await upload(app, token, scopeId, { name: 'x.md', content: '# x\n\n正文。' })
    await new Promise((r) => setTimeout(r, 200))
    const doc = db
      .prepare('SELECT status FROM documents WHERE id = ?')
      .get(up.body.docId as string) as { status: string }
    expect(doc.status).toBe('pending')
  })
})
