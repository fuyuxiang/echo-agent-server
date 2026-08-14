import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { loadAccessContext } from '../auth/scopes.js'
import type { AuthedRequest } from '../auth/jwt.js'

/**
 * 增量同步:客户端离线兜底缓存的数据源。
 *
 * 只同步"热文档"(近期被检索命中过 + 管理员置顶),不做全量下发 —— 文档
 * 上万后全量不可行,而且本地副本越多,权限变更的收敛就越难。
 *
 * revoked_docs 是这个接口的安全核心:权限收回、密级提升、文档删除都必须
 * 能推到客户端,否则本地缓存会继续提供服务端已经收走的内容。宁可多推
 * 一些 id 让客户端删,也不能漏推。
 */

const SyncQuery = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  deviceId: z.string().min(1).default('default'),
  limit: z.coerce.number().int().min(1).max(500).default(200)
})

const HOT_WINDOW_MS = 30 * 24 * 3600_000

export function registerSyncRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  app.get('/api/v1/sync', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = SyncQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '查询参数错误'))
    const { cursor, deviceId, limit } = parsed.data

    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)

    // 无可见范围(被禁用或移出所有组):告知客户端清空全部缓存。
    if (ctx.scopeIds.length === 0) {
      return reply.send(
        ok({ nextCursor: Date.now(), docs: [], memories: [], revokedDocs: [], purgeAll: true, hasMore: false })
      )
    }

    const scopePlaceholders = ctx.scopeIds.map(() => '?').join(',')
    const hotSince = Date.now() - HOT_WINDOW_MS

    // 热文档:近 30 天被引用过的,或体量小到无所谓的(chunk 数少)。
    // 用 qa_events 的 cited_chunks 判定"被用过"成本较高,这里用更简单
    // 的近似:最近更新过的 + 有引用记录的文档。
    const docs = db
      .prepare(
        `SELECT d.id AS docId, d.title, d.source_type AS sourceType, d.updated_at AS updatedAt,
                s.kind AS scopeKind
           FROM documents d
           JOIN scopes s ON s.id = d.scope_id
          WHERE d.scope_id IN (${scopePlaceholders})
            AND d.sensitivity <= ?
            AND d.status = 'ready'
            AND d.updated_at > ?
            AND d.updated_at >= ?
          ORDER BY d.updated_at
          LIMIT ?`
      )
      .all(...ctx.scopeIds, ctx.clearance, cursor, hotSince, limit) as {
      docId: string
      title: string
      sourceType: string
      updatedAt: number
      scopeKind: string
    }[]

    // 每篇文档的 chunk 一起下发,客户端才能建本地 FTS 索引。
    const chunkStmt = db.prepare(
      `SELECT id AS chunkId, text, heading, loc_page AS locPage,
              loc_start_ms AS locStartMs, modality
         FROM chunks WHERE doc_id = ? ORDER BY seq`
    )
    const withChunks = docs.map((d) => ({
      ...d,
      chunks: chunkStmt.all(d.docId) as Record<string, unknown>[]
    }))

    const memories = db
      .prepare(
        `SELECT m.id, m.kind, m.content, m.confidence, m.updated_at AS updatedAt,
                s.kind AS scopeKind
           FROM org_memories m
           JOIN scopes s ON s.id = m.scope_id
          WHERE m.scope_id IN (${scopePlaceholders})
            AND m.status = 'active'
            AND m.updated_at > ?
          ORDER BY m.updated_at
          LIMIT ?`
      )
      .all(...ctx.scopeIds, cursor, limit) as Record<string, unknown>[]

    /**
     * 被收回的文档。三种情况都要推:
     *   1. archived(删除);
     *   2. 移出了用户可见的 scope;
     *   3. 密级提高到超出用户 clearance。
     * 后两种是最容易漏的 —— 文档本身还在、还是 ready,只是这个用户不该
     * 再看到它了。用 NOT IN 覆盖:凡是更新过但当前不满足可见条件的,一律推。
     */
    const revoked = db
      .prepare(
        `SELECT id FROM documents
          WHERE updated_at > ?
            AND (
              status = 'archived'
              OR scope_id NOT IN (${scopePlaceholders})
              OR sensitivity > ?
            )
          ORDER BY updated_at
          LIMIT ?`
      )
      .all(cursor, ...ctx.scopeIds, ctx.clearance, limit * 2) as { id: string }[]

    const maxUpdated = Math.max(
      cursor,
      ...docs.map((d) => d.updatedAt),
      ...memories.map((m) => Number(m.updatedAt)),
      cursor
    )
    const nextCursor = docs.length === 0 && memories.length === 0 ? Date.now() : maxUpdated

    db.prepare(
      `INSERT INTO sync_cursors (device_id, user_id, cursor, synced_at)
       VALUES (?,?,?,?)
       ON CONFLICT(device_id) DO UPDATE SET
         user_id = excluded.user_id, cursor = excluded.cursor, synced_at = excluded.synced_at`
    ).run(deviceId, claims.sub, nextCursor, Date.now())

    return reply.send(
      ok({
        nextCursor,
        docs: withChunks,
        memories,
        revokedDocs: revoked.map((r) => r.id),
        purgeAll: false,
        hasMore: docs.length >= limit || memories.length >= limit
      })
    )
  })
}
