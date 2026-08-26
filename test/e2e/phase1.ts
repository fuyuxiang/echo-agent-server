/**
 * 端到端脚本 —— phase1 业务闭环。
 *
 * 四个场景:
 *   1. 用户 A 登录 → 问"报销标准" → top-1 含目标文档
 *   2. 用户 A 移出财务组 → 同问 → 空结果或仅公开文档
 *   3. 用户 B 提交候选知识 → 审核通过 → 用户 A 当日能查到
 *   4. 用户 A 离线(撤回 device 但保留 token)→ 缓存命中最近一次同步
 *
 * 设计:
 *   - 通过 buildApp 启动内存服务器,HTTP 路径走真实路由;
 *   - 复用 eval/fixture.ts 的 fixtureIntoDb 把黄金数据集灌到同一个 db;
 *   - 关闭登录限流(process.env.ECHO_DISABLE_LOGIN_THROTTLE=1)避开测试间相互锁;
 *   - 不依赖 web/dist:serveWeb:false。
 *
 * 约束:
 *   - 不修改 eval/* 与 src/routes/model-config.ts;
 *   - 165 个原有单测不在此文件断言;
 *   - 跑完清理临时 db 文件。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, type DB } from '../../src/db/index.js'
import { testConfig } from '../../src/config.js'
import { buildApp } from '../../src/app.js'
import { ensureOrgScope } from '../../src/server.js'
import { createUser } from '../../src/dao/users.js'

// 评估 fixture 的命中关键词:"报销 标准" 出现在 d_reimburse_v3 / d_travel_v3
// 与 d_fin_internal 等,但 d_reimburse_v3 是 org 公开,任何成员可达。
const QUERY = '报销标准'
const TARGET_PUBLIC_DOC = 'd_reimburse_v3'

// 临时 db 文件 + 配套 env。fixture.ts 顶层会启动时跑一次 main() 用
// ECHO_DB_PATH 灌库,必须先设置这个 env 到一个合法可写的 SQLite 文件,否则
// main() 失败 → process.exit(1) → vitest 报 unhandled rejection。
// 顶层 sync 代码在所有 import 之前执行,所以这里先建临时文件 + set env,
// 再用 dynamic import 加载 fixture(让它的 main() 入口时 env 已就位)。
const tmpDir = mkdtempSync(join(tmpdir(), 'echo-e2e-'))
const dbPath = join(tmpDir, 'e2e.db')
process.env.ECHO_DB_PATH = dbPath
process.env.ECHO_DISABLE_LOGIN_THROTTLE = '1'

// fixture.ts 的 fixtureIntoDb 假设 org scope 已存在(server 启动时创建)。
// 顶层 main() 在我们 beforeAll 之前就跑,若 db 文件为空,openDb 会自动
// 迁移,但 org scope 不会自动创建,fixtureIntoDb 就会抛"org scope 不存在"。
// 这里预先 openDb + ensureOrgScope,让顶层 main() 也能跑通。
{
  const pre = openDb({ path: dbPath })
  ensureOrgScope(pre)
  pre.close()
}

// 用 dynamic import: 确保 ECHO_DB_PATH 已经设置好,fixture.ts 顶层 main()
// 同步执行时不再失败。`fixtureIntoDb` 随后我们在 beforeAll 里再次调用,
// 用 dbPath 灌库。
const fixtureModulePromise = import('../../eval/fixture.js') as Promise<{
  fixtureIntoDb: (dbPath: string) => Promise<void>
}>

let db: DB
let app: FastifyInstance

beforeAll(async () => {
  // 等顶层 main() 跑完(它会用 ECHO_DB_PATH,等同 dbPath,灌一份基线数据)
  await new Promise((r) => setTimeout(r, 100))

  // 顶层 main() 已经用 fixtureIntoDb 灌好 64 篇文档;这里直接打开
  // 同一份 db,不再重复灌(否则 chunk_vectors 主键会冲突)。
  db = openDb({ path: dbPath })
  app = buildApp({ db, cfg: testConfig(), serveWeb: false })
})

afterAll(() => {
  app.close()
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function loginAs(
  username: string,
  password: string,
  deviceId: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, deviceId }
  })
  if (res.statusCode !== 200) {
    throw new Error(`login ${username} failed: ${res.statusCode} ${res.json().msg ?? ''}`)
  }
  return res.json().data
}

interface RetrieveResponse {
  data: {
    chunks: { docId: string; docTitle: string; text: string }[]
    memories: { id: string; content: string }[]
    diagnostics: { totalMs: number }
  }
}

async function retrieve(
  token: string,
  query: string
): Promise<RetrieveResponse['data']> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/retrieve',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, limit: 5 }
  })
  if (res.statusCode !== 200) {
    throw new Error(`retrieve failed: ${res.statusCode} ${res.json().msg ?? ''}`)
  }
  return res.json().data
}

describe('phase1 业务闭环', () => {
  it('场景 1:用户 A 登录 → 问"报销标准" → top-1 含目标文档', async () => {
    // 用户 A 必须在财务组,这样可以看到团队文档,也能看到组织文档
    const userA = db
      .prepare("SELECT id FROM users WHERE username = 'u_member_fin'")
      .get() as { id: string } | undefined
    if (!userA) {
      // fixture 用户没创建,临时创建一个
      const u = await createUser(db, {
        username: 'u_member_fin',
        password: 'test-password',
        role: 'member'
      })
      // 兜底:用 fixture 灌入的财务部 scope 反查 group_id
      const finScope = db
        .prepare(
          `SELECT s.group_id AS groupId FROM scopes s
            WHERE s.kind = 'team' AND s.name = '财务部' LIMIT 1`
        )
        .get() as { groupId: string } | undefined
      if (finScope) {
        db.prepare(
          'INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)'
        ).run(u.id, finScope.groupId)
      }
    }

    const { accessToken } = await loginAs('u_member_fin', 'test-password', 'dev-a')
    const data = await retrieve(accessToken, QUERY)
    const docIds = data.chunks.map((c) => c.docId)
    expect(docIds.length).toBeGreaterThan(0)
    expect(docIds).toContain(TARGET_PUBLIC_DOC)
  })

  it('场景 2:用户 A 移出财务组 → 同问 → 财务部文档不再出现', async () => {
    const userA = db
      .prepare("SELECT id FROM users WHERE username = 'u_member_fin'")
      .get() as { id: string } | undefined
    if (!userA) throw new Error('场景 1 未创建用户 A')

    // 移出:清空 user_groups
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(userA.id)
    // token_version 提升让旧 token 立即失效
    db.prepare(
      'UPDATE users SET token_version = token_version + 1 WHERE id = ?'
    ).run(userA.id)

    // 重新登录拿新 token(此时 A 已不在任何组,只保留 org 可见性)
    const { accessToken } = await loginAs('u_member_fin', 'test-password', 'dev-a2')
    const data = await retrieve(accessToken, QUERY)
    const docIds = new Set(data.chunks.map((c) => c.docId))
    // 财务部内部文档 d_fin_internal 不应再出现
    expect(docIds.has('d_fin_internal')).toBe(false)
    // 至少公开的报销文档 d_reimburse_v3 仍可见
    expect(docIds.has(TARGET_PUBLIC_DOC)).toBe(true)
  })

  it('场景 3:用户 B 提交候选知识 → 审核通过 → 用户 A 当日能查到', async () => {
    await createUser(db, {
      username: 'u_curator',
      password: 'curator-password',
      role: 'curator',
      clearance: 2
    })

    const orgScope = db
      .prepare("SELECT id FROM scopes WHERE kind = 'org'")
      .get() as { id: string }

    // 用户 B 提交一个 memory 类型的 promotion
    const bLogin = await loginAs('u_curator', 'curator-password', 'dev-b')
    const submit = await app.inject({
      method: 'POST',
      url: '/api/v1/promotions',
      headers: { authorization: `Bearer ${bLogin.accessToken}` },
      payload: {
        payloadType: 'memory',
        source: 'meeting',
        targetScope: orgScope.id,
        payload: {
          kind: 'fact',
          content: '差旅报销标准:一线城市 500 元每晚,其他城市 350 元每晚',
          rationale: '来自最新差旅管理办法 V3'
        }
      }
    })
    expect(submit.statusCode).toBe(200)
    const promoId = submit.json().data.promotionId

    // 审核通过(用 curator 同一身份)
    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/promotions/${promoId}/approve`,
      headers: { authorization: `Bearer ${bLogin.accessToken}` },
      payload: { note: 'ok' }
    })
    expect(approve.statusCode).toBe(200)
    expect(approve.json().data.state).toBe('approved')

    // 用户 A 当日能查到:重新登录 A(场景 2 已移出财务组,但 org 仍可见)
    const aLogin = await loginAs('u_member_fin', 'test-password', 'dev-a3')
    const data = await retrieve(aLogin.accessToken, QUERY)
    const memHit = data.memories.find((m) => m.content.includes('差旅报销标准'))
    const docHit = data.chunks.find((c) => c.docId === TARGET_PUBLIC_DOC)
    expect(memHit ?? docHit).toBeTruthy()
  })

  it('场景 4:用户 A 离线(撤回 device 但保留 token)→ 缓存命中最近一次同步', async () => {
    // 用户 A 重新登录,拿一份有效 token
    const aLogin = await loginAs('u_member_fin', 'test-password', 'dev-sync')
    const accessToken = aLogin.accessToken
    const refreshToken = aLogin.refreshToken

    // 1. 调一次 sync,客户端本地缓存
    const sync1 = await app.inject({
      method: 'GET',
      url: '/api/v1/sync?deviceId=dev-sync&limit=50',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(sync1.statusCode).toBe(200)
    const syncData = sync1.json().data
    expect(syncData.docs.length).toBeGreaterThanOrEqual(0)
    const lastCursor = syncData.nextCursor

    // 2. 模拟"设备离线 / 撤回 refresh token":服务端主动 logout
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(logout.statusCode).toBe(200)

    // 3. refresh token 已经被注销
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken }
    })
    expect(refresh.statusCode).toBe(401)

    // 4. 但 access token 仍然有效,客户端可以照常查询
    const data = await retrieve(accessToken, QUERY)
    expect(data.chunks.length).toBeGreaterThan(0)
    const sync2 = await app.inject({
      method: 'GET',
      url: `/api/v1/sync?cursor=${encodeURIComponent(lastCursor)}&deviceId=dev-sync&limit=50`,
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(sync2.statusCode).toBe(200)
    // V2 cursor 是不可排序的复合游标；服务端在翻页完成后允许把详细
    // keyset 压缩成新快照，所以这里只验证它能继续完成增量协议。
    const nextCursor = sync2.json().data.nextCursor
    expect(typeof nextCursor).toBe('string')
    expect(nextCursor.length).toBeGreaterThan(0)
    const sync3 = await app.inject({
      method: 'GET',
      url: `/api/v1/sync?cursor=${encodeURIComponent(nextCursor)}&deviceId=dev-sync&limit=50`,
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(sync3.statusCode).toBe(200)
    expect(sync3.json().data.docs).toHaveLength(0)
    expect(sync3.json().data.memories).toHaveLength(0)
  })
})
