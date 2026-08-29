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
  | 'document_submit'
  | 'document_withdraw'
  | 'document_review_download'
  | 'knowledge_ask'
  | 'skill_submit'
  | 'skill_publish'
  | 'skill_approve'
  | 'skill_reject'
  | 'skill_download'
  | 'skill_review_download'
  | 'skill_revoke'

/**
 * 审计写入。
 *
 * SQLite 是进程内嵌数据库，单次 INSERT 很短。这里选择同步、fail-open 写入：
 * 请求不会因为审计失败而失败，同时也不存在 setImmediate 排队后数据库已经
 * close 的退出竞态。需要更高吞吐时应换成有 drain() 生命周期的独立 AuditSink，
 * 不能重新引入无人等待的后台任务。
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

  const failures = { count: 0 }

  function audit(
    req: FastifyRequest | null,
    action: AuditAction,
    target?: string,
    detail?: Record<string, unknown>
  ): void {
    try {
      write(req, action, target, detail)
    } catch (e) {
      failures.count += 1
      onError?.(e)
      // eslint-disable-next-line no-console
      console.error(`[audit] 写入失败 (累计 ${failures.count}):`, e)
    }
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
