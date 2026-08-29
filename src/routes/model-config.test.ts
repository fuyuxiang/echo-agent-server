import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb, type DB } from '../db/index.js'
import { testConfig } from '../config.js'
import { buildApp } from '../app.js'
import { createUser } from '../dao/users.js'
import { ensureOrgScope } from '../server.js'

/**
 * 模型配置热加载单元测试。
 *
 * 目标:PUT /api/v1/admin/model-config 之后,/api/v1/health 立刻反映新的
 * 模型名,且 app.deps.embedder / app.deps.reranker 引用被替换 —— 即
 * "配而后热"的核心保证。
 *
 * 实现要点:
 *   - 用带 embedUrl / rerankUrl 的 testConfig 启动,让 createEmbedder 返回
 *     RemoteEmbedder(createReranker 返回 RemoteReranker);它们的 model
 *     字段由 cfg.embedModel / cfg.rerankModel 决定,PUT 改了这两个字段
 *     后,新实例的 model 也跟着变 —— 不依赖任何真模型,fetch 不会被调用。
 *   - 用 process.env.ECHO_DISABLE_LOGIN_THROTTLE=1 绕开管理员登录限流,
 *     方便多次 PUT。
 */

async function setup(): Promise<{
  db: DB
  app: FastifyInstance
  cfg: ReturnType<typeof testConfig>
}> {
  // 测试间清理 throttle,避免连续 PUT 时被限流。
  process.env.ECHO_DISABLE_LOGIN_THROTTLE = '1'
  const cfg = testConfig({
    embedUrl: 'http://embed.test.invalid/v1',
    embedKey: 'sk-embed-test',
    rerankUrl: 'http://rerank.test.invalid/v1',
    rerankKey: 'rk-rerank-test',
    embedModel: 'embed-v1',
    rerankModel: 'rerank-v1',
    embedDim: 1024
  })
  const db = openDb({ path: ':memory:' })
  ensureOrgScope(db)
  await createUser(db, {
    username: 'admin',
    password: 'admin-password',
    role: 'admin',
    clearance: 2
  })
  const app = buildApp({ db, cfg, serveWeb: false })
  return { db, app, cfg }
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, deviceId: 'hotreload-dev' }
  })
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.json().msg ?? ''}`)
  }
  return res.json().data.accessToken
}

const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })

describe('模型配置热加载', () => {
  let db: DB
  let app: FastifyInstance

  beforeEach(async () => {
    ;({ db, app } = await setup())
  })

  it('PUT 写入后,/api/v1/health 立刻返回新模型名,无需重启', async () => {
    const token = await login(app, 'admin', 'admin-password')

    // 1. 健康检查:启动后看到的是 testConfig 里的 embed-v1 / rerank-v1
    const health1 = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(health1.statusCode).toBe(200)
    expect(health1.json().models.embedder).toBe('embed-v1')
    expect(health1.json().models.reranker).toBe('rerank-v1')

    // 记录旧实例引用,用于事后比对"是不是真的换了"。
    const embedderBefore = app.deps.embedder
    const rerankerBefore = app.deps.reranker

    // 2. PUT 改成 embed-v2 / rerank-v2
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(token),
      payload: {
        chatProvider: 'openai',
        chatModel: 'gpt-4o-mini',
        embedModel: 'embed-v2',
        embedDim: 1024,
        rerankModel: 'rerank-v2'
      }
    })
    expect(put.statusCode).toBe(200)

    // 3. 再调 /api/v1/health,应当立刻反映新模型
    const health2 = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(health2.statusCode).toBe(200)
    expect(health2.json().models.embedder).toBe('embed-v2')
    expect(health2.json().models.reranker).toBe('rerank-v2')

    // 4. 实例必须被替换(不是同一对象)
    expect(app.deps.embedder).not.toBe(embedderBefore)
    expect(app.deps.reranker).not.toBe(rerankerBefore)
    // 而且新实例的 model 字段就是 cfg 上的值
    expect(app.deps.embedder.model).toBe('embed-v2')
    expect(app.deps.reranker.model).toBe('rerank-v2')
  })

  it('拒绝把 embedDim 热切换到与物理向量表不同的维度', async () => {
    const token = await login(app, 'admin', 'admin-password')

    expect(app.deps.embedder.dim).toBe(1024)

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(token),
      payload: {
        chatProvider: 'openai',
        chatModel: 'gpt-4o-mini',
        embedModel: 'embed-v1',
        embedDim: 2048,
        rerankModel: 'rerank-v1'
      }
    })
    expect(put.statusCode).toBe(409)
    expect(put.json().msg).toContain('全量重建索引')

    expect(app.deps.embedder.dim).toBe(1024)
  })

  it('GET /api/v1/model-config 在 PUT 后返回的 runtime 信息同步更新', async () => {
    const token = await login(app, 'admin', 'admin-password')

    // 第一次 GET:runtime 来自启动时的实例
    const get1 = await app.inject({
      method: 'GET',
      url: '/api/v1/model-config',
      headers: bearer(token)
    })
    expect(get1.statusCode).toBe(200)
    expect(get1.json().data.configured).toBe(false) // DB 还没行
    expect(get1.json().data.runtime.embedder).toBe('embed-v1')

    // PUT
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(token),
      payload: {
        chatProvider: 'openai',
        chatModel: 'gpt-4o-mini',
        embedModel: 'embed-v3',
        embedDim: 1024,
        rerankModel: 'rerank-v3'
      }
    })
    expect(put.statusCode).toBe(200)

    // 第二次 GET:runtime 必须用最新的实例,不能是旧引用
    const get2 = await app.inject({
      method: 'GET',
      url: '/api/v1/model-config',
      headers: bearer(token)
    })
    expect(get2.statusCode).toBe(200)
    expect(get2.json().data.configured).toBe(true)
    expect(get2.json().data.runtime.embedder).toBe('embed-v3')
    expect(get2.json().data.runtime.reranker).toBe('rerank-v3')
  })

  it('PUT 写入审计日志 config_change', async () => {
    const token = await login(app, 'admin', 'admin-password')

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(token),
      payload: {
        chatProvider: 'openai',
        chatModel: 'gpt-4o-mini',
        embedModel: 'embed-v1',
        embedDim: 1024,
        rerankModel: 'rerank-v1'
      }
    })
    expect(put.statusCode).toBe(200)

    // 审计是异步 setImmediate,等一拍再查库。
    await new Promise<void>((r) => setImmediate(r))

    const row = db
      .prepare(
        "SELECT action, target, detail FROM audit_logs WHERE action='config_change' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { action: string; target: string; detail: string } | undefined
    expect(row).toBeTruthy()
    expect(row!.target).toBe('default')
    const detail = JSON.parse(row!.detail) as Record<string, unknown>
    expect(detail.embedModel).toBe('embed-v1')
  })

  it('未登录调用 PUT 返回 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      payload: {
        chatProvider: 'openai',
        chatModel: 'gpt-4',
        embedModel: 'm',
        embedDim: 1024
      }
    })
    expect(res.statusCode).toBe(401)
  })

  it('非管理员调用 PUT 返回 403', async () => {
    await createUser(db, { username: 'alice', password: 'alice-password' })
    const token = await login(app, 'alice', 'alice-password')
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(token),
      payload: {
        chatProvider: 'openai',
        chatModel: 'gpt-4',
        embedModel: 'm',
        embedDim: 1024
      }
    })
    expect(res.statusCode).toBe(403)
  })

  it('PUT 入参缺字段返回 400', async () => {
    const token = await login(app, 'admin', 'admin-password')
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(token),
      payload: {
        chatProvider: 'openai'
        // 缺 chatModel / embedModel / embedDim
      }
    })
    expect(res.statusCode).toBe(400)
  })
})
