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
  | 'approve'
  | 'reject'
  | 'config_change'
  | 'user_change'

/**
 * 审计写入。
 *
 * 同步写但不抛错:审计失败绝不能让业务请求失败,而合规要求又不允许静默
 * 丢弃 —— 折中是失败时打到 stderr,让运维能从进程日志里发现问题。
 *
 * 不记录检索到的具体内容,只记 who/when/what,避免审计表本身变成一份
 * 绕过权限的知识副本。
 */
export function makeAudit(db: DB, onError?: (e: unknown) => void) {
  const stmt = db.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target, detail, ip, created_at)
     VALUES (?,?,?,?,?,?,?)`
  )

  return function audit(
    req: FastifyRequest | null,
    action: AuditAction,
    target?: string,
    detail?: Record<string, unknown>
  ): void {
    try {
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
    } catch (e) {
      onError?.(e)
    }
  }
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
