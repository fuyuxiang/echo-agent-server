import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb, type DB } from '../src/db/index.js'
import { testConfig, type Config } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { createUser } from '../src/dao/users.js'
import { ensureOrgScope } from '../src/server.js'

async function setup(over: Partial<Config> = {}): Promise<{ db: DB; app: FastifyInstance }> {
  const db = openDb({ path: ':memory:' })
  ensureOrgScope(db)
  await createUser(db, {
    username: 'admin',
    password: 'admin-password',
    role: 'admin',
    clearance: 2
  })
  await createUser(db, { username: 'alice', password: 'alice-password' })
  return { db, app: buildApp({ db, cfg: testConfig(over), serveWeb: false }) }
}

async function login(
  app: FastifyInstance,
  username: string,
  password: string,
  deviceId = 'dev1'
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, deviceId }
  })
  return res.json().data
}

const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })

describe('鉴权', () => {
  let db: DB
  let app: FastifyInstance

  beforeEach(async () => {
    ;({ db, app } = await setup())
  })

  it('登录成功返回 token 与会话信息', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'alice-password', deviceId: 'dev1' }
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.accessToken).toBeTruthy()
    expect(d.refreshToken).toBeTruthy()
    expect(d.user.username).toBe('alice')
    // org scope 应当自动可见
    expect(d.user.scopes.length).toBeGreaterThan(0)
    expect(res.headers['set-cookie']).toContain('echo_refresh=')
    expect(res.headers['set-cookie']).toContain('HttpOnly')
    expect(res.headers['set-cookie']).toContain('SameSite=Strict')
  })

  it('管理后台可只用 HttpOnly cookie 轮换 refresh token', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'alice-password', deviceId: 'admin-web' }
    })
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie },
      payload: {}
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().data.accessToken).toBeTruthy()
    expect(refreshed.headers['set-cookie']).toContain('echo_refresh=')
  })

  it('可按入口协议显式控制 refresh cookie 的 Secure 属性', async () => {
    const secure = await setup({ cookieSecure: true })
    const secureLogin = await secure.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'alice-password' }
    })
    expect(secureLogin.headers['set-cookie']).toContain('Secure')

    const http = await setup({ cookieSecure: false })
    const httpLogin = await http.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'alice-password' }
    })
    expect(httpLogin.headers['set-cookie']).not.toContain('Secure')
  })

  it('密码错误与用户不存在返回相同错误(防用户名枚举)', async () => {
    const wrongPw = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'nope-nope-nope' }
    })
    const noUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ghost', password: 'nope-nope-nope' }
    })
    expect(wrongPw.statusCode).toBe(401)
    expect(noUser.statusCode).toBe(401)
    expect(wrongPw.json().msg).toBe(noUser.json().msg)
  })

  it('token 不携带 scope 信息(避免权限固化在 token 里)', async () => {
    const { accessToken } = await login(app, 'alice', 'alice-password')
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString()
    )
    expect(payload.sub).toBeTruthy()
    expect(payload.tv).toBe(1)
    expect(payload.scopes).toBeUndefined()
    expect(payload.groups).toBeUndefined()
  })

  it('无 token 访问受保护接口返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' })
    expect(res.statusCode).toBe(401)
  })

  it('禁用用户的既有 token 立即失效', async () => {
    const { accessToken } = await login(app, 'alice', 'alice-password')
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(accessToken)
    })
    expect(before.statusCode).toBe(200)

    const alice = db.prepare("SELECT id FROM users WHERE username='alice'").get() as {
      id: string
    }
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(alice.id)

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(accessToken)
    })
    expect(after.statusCode).toBe(401)
  })

  // token_version 的意义:改密码/降权后旧 token 必须当场作废,
  // 而不是等它自然过期。
  it('token_version 递增后旧 token 失效', async () => {
    const { accessToken } = await login(app, 'alice', 'alice-password')
    db.prepare("UPDATE users SET token_version = token_version + 1 WHERE username='alice'").run()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(accessToken)
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(4014)
  })

  it('refresh 换出新 access token', async () => {
    const { refreshToken } = await login(app, 'alice', 'alice-password')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.accessToken).toBeTruthy()
  })

  it('refresh token 一次性使用,重放被拒', async () => {
    const { refreshToken } = await login(app, 'alice', 'alice-password')
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken }
    })
    expect(first.statusCode).toBe(200)

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken }
    })
    expect(replay.statusCode).toBe(401)
  })

  it('refresh token 只存哈希,库里查不到明文', async () => {
    const { refreshToken } = await login(app, 'alice', 'alice-password')
    const row = db
      .prepare('SELECT token_hash FROM refresh_tokens WHERE token_hash = ?')
      .get(refreshToken)
    expect(row).toBeUndefined()
    const count = db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get() as {
      n: number
    }
    expect(count.n).toBe(1)
  })

  it('登出后 refresh token 失效', async () => {
    const { accessToken, refreshToken } = await login(app, 'alice', 'alice-password')
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: bearer(accessToken)
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken }
    })
    expect(res.statusCode).toBe(401)
  })

  it('连续失败触发限流', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'alice', password: 'wrong-password' }
      })
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'alice-password' }
    })
    expect(res.statusCode).toBe(429)
  })
})

describe('权限与角色', () => {
  let db: DB
  let app: FastifyInstance

  beforeEach(async () => {
    ;({ db, app } = await setup())
  })

  it('普通成员访问管理接口返回 403', async () => {
    const { accessToken } = await login(app, 'alice', 'alice-password')
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(accessToken)
    })
    expect(res.statusCode).toBe(403)
  })

  it('管理员可列出用户', async () => {
    const { accessToken } = await login(app, 'admin', 'admin-password')
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(accessToken)
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.length).toBe(2)
  })

  it('角色以库为准,不信 token 里的旧角色', async () => {
    const { accessToken } = await login(app, 'admin', 'admin-password')
    // 直接降权(绕过路由的自我保护),模拟另一管理员的操作
    db.prepare("UPDATE users SET role='member' WHERE username='admin'").run()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(accessToken)
    })
    // token 里仍写着 admin,但库里已是 member
    expect(res.statusCode).toBe(403)
  })

  it('管理员不能禁用自己', async () => {
    const { accessToken } = await login(app, 'admin', 'admin-password')
    const me = db.prepare("SELECT id FROM users WHERE username='admin'").get() as {
      id: string
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${me.id}`,
      headers: bearer(accessToken),
      payload: { status: 'disabled' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('改密码作废该用户全部会话', async () => {
    const alice = await login(app, 'alice', 'alice-password')
    const { accessToken: adminToken } = await login(app, 'admin', 'admin-password', 'dev2')
    const aliceId = (
      db.prepare("SELECT id FROM users WHERE username='alice'").get() as { id: string }
    ).id

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${aliceId}/password`,
      headers: bearer(adminToken),
      payload: { password: 'brand-new-password' }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(alice.accessToken)
    })
    expect(res.statusCode).toBe(401)
  })

  it('建组同时创建 team scope', async () => {
    const { accessToken } = await login(app, 'admin', 'admin-password')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/groups',
      headers: bearer(accessToken),
      payload: { name: '财务部' }
    })
    expect(res.statusCode).toBe(200)
    const { id, scopeId } = res.json().data
    expect(scopeId).toBeTruthy()
    const scope = db
      .prepare("SELECT * FROM scopes WHERE group_id = ? AND kind='team'")
      .get(id)
    expect(scope).toBeTruthy()
  })

  it('成员只看到自己可见的 scope', async () => {
    const { accessToken: adminToken } = await login(app, 'admin', 'admin-password')
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/groups',
      headers: bearer(adminToken),
      payload: { name: '财务部' }
    })

    const { accessToken } = await login(app, 'alice', 'alice-password', 'dev3')
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/scopes',
      headers: bearer(accessToken)
    })
    const kinds = res.json().data.map((s: { kind: string }) => s.kind)
    // alice 不属于财务部，但每个用户始终拥有自己的 personal scope。
    expect(kinds).toEqual(['org', 'personal'])
  })
})

describe('模型配置', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    ;({ app } = await setup())
  })

  // 明文 Key 下发到客户端就无法回收:散落在每台机器的内存、磁盘缓存与
  // 崩溃日志里,撤销要通知所有客户端。这条断言守住"Key 只存服务端"。
  it('绝不下发明文 API Key', async () => {
    const { accessToken } = await login(app, 'admin', 'admin-password')
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(accessToken),
      payload: {
        chatProvider: 'openai',
        chatModel: 'gpt-4o',
        chatKey: 'sk-super-secret-value',
        embedModel: 'bge-m3',
        embedDim: 1024
      }
    })
    // 断言写入本身成功。少了这一条,加密失败会让 PUT 静默 500,
    // 而后续断言只暴露"没有凭证",看起来像是读接口的问题。
    expect(put.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/model-config',
      headers: bearer(accessToken)
    })
    const body = JSON.stringify(res.json())
    expect(body).not.toContain('sk-super-secret-value')
    expect(res.json().data.hasCredential).toBe(true)
    expect(res.json().data.proxied).toBe(true)
  })

  it('留空 chatKey 时保留原有凭证', async () => {
    const { accessToken } = await login(app, 'admin', 'admin-password')
    const base = {
      chatProvider: 'openai',
      chatModel: 'gpt-4o',
      embedModel: 'bge-m3',
      embedDim: 1024
    }
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(accessToken),
      payload: { ...base, chatKey: 'sk-first' }
    })
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(accessToken),
      payload: { ...base, chatModel: 'gpt-4o-mini' }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/model-config',
      headers: bearer(accessToken)
    })
    expect(res.json().data.hasCredential).toBe(true)
    expect(res.json().data.chatModel).toBe('gpt-4o-mini')
  })

  it('普通成员不能改模型配置', async () => {
    const { accessToken } = await login(app, 'alice', 'alice-password')
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/model-config',
      headers: bearer(accessToken),
      payload: {
        chatProvider: 'openai',
        chatModel: 'gpt-4o',
        embedModel: 'bge-m3',
        embedDim: 1024
      }
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('健康检查', () => {
  it('返回 schema 版本', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().schemaVersion).toBeGreaterThan(0)
    expect(res.json().models).toMatchObject({
      productionReady: false,
      mode: 'degraded'
    })
    expect(res.json().models.readinessReasons).toEqual(expect.arrayContaining([
      'embedding_unavailable',
      'reranker_unavailable',
      'chat_unavailable'
    ]))
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
  })

  it('纯 HTTP 入口不强制升级静态资源，HTTPS 入口保留安全策略', async () => {
    const http = await setup({ cookieSecure: false })
    const httpRes = await http.app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(httpRes.headers['content-security-policy']).not.toContain(
      'upgrade-insecure-requests',
    )
    expect(httpRes.headers['strict-transport-security']).toBeUndefined()

    const https = await setup({ cookieSecure: true })
    const httpsRes = await https.app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(httpsRes.headers['content-security-policy']).toContain(
      'upgrade-insecure-requests',
    )
    expect(httpsRes.headers['strict-transport-security']).toBeTruthy()
  })

  it('核心模型通过环境配置后可达到生产就绪，可选媒体能力不误阻塞', async () => {
    const db = openDb({ path: ':memory:' })
    const app = buildApp({
      db,
      cfg: testConfig({
        chatModel: 'chat-prod',
        chatKey: 'chat-key',
        embedUrl: 'https://models.example/embeddings',
        rerankUrl: 'https://models.example/rerank'
      }),
      serveWeb: false
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.json().models).toMatchObject({
      productionReady: true,
      mode: 'production',
      readinessReasons: [],
      chat: { configured: true, source: 'environment' },
      agentic: { configured: true, maxRounds: 3, maxQueries: 8 },
      ocr: { configured: false },
      vlm: { configured: false }
    })
    await app.close()
    db.close()
  })
})
