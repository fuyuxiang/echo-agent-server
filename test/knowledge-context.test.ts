import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { testConfig } from '../src/config.js'
import { createUser } from '../src/dao/users.js'
import { openDb, type DB } from '../src/db/index.js'
import { ensureOrgScope } from '../src/server.js'

let db: DB
let app: FastifyInstance
let storageDir: string
let orgScope: string
let aliceToken: string
let bobToken: string

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, deviceId: `${username}-context` }
  })
  return response.json().data.accessToken
}

beforeEach(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'echo-context-'))
  db = openDb({ path: ':memory:' })
  orgScope = ensureOrgScope(db)
  const alice = await createUser(db, { username: 'alice', password: 'alice-password' })
  await createUser(db, { username: 'bob', password: 'bob-password' })
  const now = Date.now()
  db.prepare(
    `INSERT INTO org_memories
       (id, scope_id, kind, content, rationale, author_id, confidence, status,
        observed_at, valid_from, workspace_ref, outcome, sensitivity, trust,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    'memory-release-runbook', orgScope, 'howto',
    '发布前必须执行数据库备份并验证回滚脚本。',
    '避免数据库迁移失败时无法恢复。', alice.id, 0.94, 'active',
    now, now, 'github.com/acme/payments', '历史上降低了发布恢复时间。', 0, 'verified', now, now
  )
  const insertMemory = db.prepare(
    `INSERT INTO org_memories
       (id, scope_id, kind, content, author_id, confidence, status,
        observed_at, workspace_ref, sensitivity, trust, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?)`
  )
  insertMemory.run(
    'memory-other-workspace', orgScope, 'howto',
    '数据库迁移发布时可以跳过备份。', alice.id, 0.99,
    now, 'github.com/acme/unrelated', 0, 'verified', now, now
  )
  insertMemory.run(
    'memory-weak-overlap', orgScope, 'fact',
    '公司发布会定在下周。', alice.id, 0.99,
    now, null, 0, 'verified', now, now
  )
  app = buildApp({ db, cfg: testConfig({ storageDir }), serveWeb: false })
  aliceToken = await login('alice', 'alice-password')
  bobToken = await login('bob', 'bob-password')
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(storageDir, { recursive: true, force: true })
})

describe('任务上下文与效果反馈闭环', () => {
  it('返回可执行的组织经验并记录检索轨迹', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/context',
      headers: bearer(aliceToken),
      payload: {
        task: '如何安全发布数据库迁移？',
        mode: 'fast',
        workspaceRef: 'github.com/acme/payments',
        taskId: 'task-123',
        sessionId: 'session-123'
      }
    })

    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.traceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(data.sufficient).toBe(true)
    expect(data.memories.some((memory: { id: string }) => memory.id === 'memory-release-runbook')).toBe(true)
    expect(data.memories.some((memory: { id: string }) => memory.id === 'memory-other-workspace')).toBe(false)
    expect(data.memories.some((memory: { id: string }) => memory.id === 'memory-weak-overlap')).toBe(false)
    expect(data.runbooks).toHaveLength(1)
    expect(data.runbooks[0].workspaceRef).toBe('github.com/acme/payments')
    const stored = db.prepare(
      "SELECT task_id AS taskId, session_id AS sessionId, workspace_ref AS workspaceRef FROM knowledge_usage_events WHERE trace_id=? AND action='context'"
    ).get(data.traceId) as { taskId: string; sessionId: string; workspaceRef: string }
    expect(stored).toEqual({
      taskId: 'task-123',
      sessionId: 'session-123',
      workspaceRef: 'github.com/acme/payments'
    })
  })

  it('只允许轨迹所有者提交任务结果反馈', async () => {
    const context = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/context',
      headers: bearer(aliceToken),
      payload: { task: '数据库发布前的备份步骤', mode: 'fast' }
    })
    const traceId = context.json().data.traceId as string

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/events',
      headers: bearer(bobToken),
      payload: { traceId, action: 'apply', outcome: 'applied' }
    })
    expect(denied.statusCode).toBe(404)

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/events',
      headers: bearer(aliceToken),
      payload: {
        traceId,
        action: 'apply',
        outcome: 'applied',
        resultIds: ['memory-release-runbook'],
        feedback: '已按手册完成备份与回滚演练'
      }
    })
    expect(accepted.statusCode).toBe(200)
    const row = db.prepare(
      "SELECT outcome, feedback FROM knowledge_usage_events WHERE trace_id=? AND action='apply'"
    ).get(traceId) as { outcome: string; feedback: string }
    expect(row.outcome).toBe('applied')
    expect(row.feedback).toContain('回滚演练')
    const normalized = db.prepare(
      "SELECT result_kind AS resultKind, outcome FROM knowledge_result_feedback WHERE trace_id=?"
    ).all(traceId) as Array<{ resultKind: string; outcome: string }>
    expect(normalized).toContainEqual({ resultKind: 'memory', outcome: 'applied' })

    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/events',
      headers: bearer(aliceToken),
      payload: {
        traceId,
        action: 'feedback',
        outcome: 'helpful',
        resultIds: ['memory-not-served']
      }
    })
    expect(forged.statusCode).toBe(400)
  })
})
