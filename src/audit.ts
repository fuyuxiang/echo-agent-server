import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { DB } from './db/index.js'
import type { AuthedRequest } from './auth/jwt.js'

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'retrieve'
  | 'upload'
  | 'delete'
  | 'patch'
  | 'approve'
  | 'reject'
  | 'config_change'
  | 'user_change'
  | 'llm_chat'
  | 'conflict_resolve'
  | 'sync'
  | 'doc_read'
  | 'doc_reindex'
  | 'memory_patch'
  | 'memory_retire'
  | 'promotion_create'
  | 'promotion_withdraw'

/**
 * 审计写入。
 *
 * 异步写且不阻塞主链路:audit 失败绝不阻塞业务请求,但也不允许静默
 * 丢失 —— 失败时进 stderr 与内存失败计数,让运维可观测。
 *
 * 不记录检索到的具体内容,只记 who/when/what,避免审计表本身变成一份
 * 绕过权限的知识副本。
 */
export function makeAudit(db: DB, onError?: (e: unknown) => void) {
  const stmt = db.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target, detail, ip, created_at)
     VALUES (?,?,?,?,?,?,?)`
  )

  function write(
    req: FastifyRequest | null,
    action: AuditAction,
    target?: string,
    detail?: Record<string, unknown>
  ): void {
    const actor = req ? (req as AuthedRequest).claims?.sub ?? null : null
    const ip = req?.ip ?? null
    stmt.run(
      randomUUID(),
      actor,
      action,
      target ?? null,
      detail ? JSON.stringify(detail) : null,
      ip,
      Date.now()
    )
  }

  // 队列 + setImmediate 异步落库:主链路返回前不会等 SQLite。
  // 失败:log 写到 stderr 并计数;队列继续滚动,绝不阻塞业务。
  let pending = 0
  const failures = { count: 0 }

  function audit(
    req: FastifyRequest | null,
    action: AuditAction,
    target?: string,
    detail?: Record<string, unknown>
  ): void {
    pending += 1
    setImmediate(() => {
      pending -= 1
      try {
        write(req, action, target, detail)
      } catch (e) {
        failures.count += 1
        onError?.(e)
        // eslint-disable-next-line no-console
        console.error(`[audit] 写入失败 (累计 ${failures.count}):`, e)
      }
    })
  }

  /** 仅在测试中同步写一次,避免测试结束前还没落库。 */
  ;(audit as unknown as { _sync?: typeof write })._sync = write
  return audit as typeof audit & { _sync?: typeof write }
}

export interface AuditQuery {
  action?: string
  actorId?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export function queryAuditLogs(db: DB, q: AuditQuery = {}): unknown[] {
  const where: string[] = []
  const params: unknown[] = []
  if (q.action) { where.push('action = ?'); params.push(q.action) }
  if (q.actorId) { where.push('actor_id = ?'); params.push(q.actorId) }
  if (q.from) { where.push('created_at >= ?'); params.push(q.from) }
  if (q.to) { where.push('created_at <= ?'); params.push(q.to) }

  const sql = `
    SELECT a.id, a.actor_id AS actorId, u.display_name AS actorName,
           a.action, a.target, a.detail, a.ip, a.created_at AS createdAt
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.created_at DESC
     LIMIT ? OFFSET ?`
  return db.prepare(sql).all(...params, q.limit ?? 100, q.offset ?? 0)
}
