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
 *
 * 关键安全细节:
 *   - revoked 查询不依赖 updated_at:权限变更不一定更新文档时间;
 *   - revokedDocs 每次完整下发(删除幂等),避免权限变化因 cursor 被漏掉;
 *   - hasMore / nextCursor 覆盖文档、记忆及记忆撤销的分页;
 *   - 组织记忆撤销也要推送(retired/superseded);
 *   - sync_cursors 主键为 (user_id, device_id),避免跨用户覆盖。
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
      // 即使 cursor 没前进也写一条,避免下次继续重发旧请求。
      db.prepare(
        `INSERT INTO sync_cursors (user_id, device_id, cursor, synced_at)
         VALUES (?,?,?,?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET
           cursor = excluded.cursor, synced_at = excluded.synced_at`
      ).run(claims.sub, deviceId, Date.now(), Date.now())
      return reply.send(
        ok({
          nextCursor: Date.now(),
          docs: [],
          memories: [],
          revokedDocs: [],
          revokedMemories: [],
          purgeAll: true,
          hasMore: false
        })
      )
    }

    const scopePlaceholders = ctx.scopeIds.map(() => '?').join(',')
    const snapshotCursor = Date.now()
    const hotSince = snapshotCursor - HOT_WINDOW_MS

    // 热文档:近 30 天被引用过的,或体量小到无所谓的(chunk 数少)。
    // 用 qa_events 的 cited_chunks 判定"被用过"成本较高,这里用更简单
    // 的近似:最近更新过的 + 有引用记录的文档。
    const docRows = db
      .prepare(
        `SELECT d.id AS docId, d.title, d.source_type AS sourceType, d.updated_at AS updatedAt,
                s.kind AS scopeKind
           FROM documents d
           JOIN scopes s ON s.id = d.scope_id
          WHERE d.scope_id IN (${scopePlaceholders})
            AND d.sensitivity <= ?
            AND d.status = 'ready'
            AND d.updated_at > ?
            AND d.updated_at <= ?
            AND d.updated_at >= ?
          ORDER BY d.updated_at
          LIMIT ?`
      )
      .all(...ctx.scopeIds, ctx.clearance, cursor, snapshotCursor, hotSince, limit + 1) as {
      docId: string
      title: string
      sourceType: string
      updatedAt: number
      scopeKind: string
    }[]
    const docsHasMore = docRows.length > limit
    const docs = docRows.slice(0, limit)

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

    const memoryRows = db
      .prepare(
        `SELECT m.id, m.kind, m.content, m.confidence, m.updated_at AS updatedAt,
                s.kind AS scopeKind
           FROM org_memories m
           JOIN scopes s ON s.id = m.scope_id
          WHERE m.scope_id IN (${scopePlaceholders})
            AND m.status = 'active'
            AND m.updated_at > ?
            AND m.updated_at <= ?
          ORDER BY m.updated_at
          LIMIT ?`
      )
      .all(...ctx.scopeIds, cursor, snapshotCursor, limit + 1) as Record<string, unknown>[]
    const memoriesHasMore = memoryRows.length > limit
    const memories = memoryRows.slice(0, limit)

    // 组织记忆撤销:retired 或 superseded;同样用 updated_at 触发。
    const revokedMemoryRows = db
      .prepare(
        `SELECT m.id, m.updated_at AS updatedAt
           FROM org_memories m
          WHERE m.scope_id IN (${scopePlaceholders})
            AND m.status IN ('retired','superseded')
            AND m.updated_at > ?
            AND m.updated_at <= ?
          ORDER BY m.updated_at
          LIMIT ?`
      )
      .all(...ctx.scopeIds, cursor, snapshotCursor, limit + 1) as { id: string; updatedAt: number }[]
    const revokedMemoriesHasMore = revokedMemoryRows.length > limit
    const revokedMemories = revokedMemoryRows.slice(0, limit)

    /**
     * 被收回的文档。三种情况都要推,且不依赖 updated_at:
     *   1. archived(删除);
     *   2. 移出了用户可见的 scope;
     *   3. 密级提高到超出用户 clearance。
     * 后两种是最容易漏的 —— 文档本身还在、还是 ready,只是这个用户不该
     * 再看到它了。每条 revoked 都需要被客户端清缓存。
     */
    const revokedDocs = db
      .prepare(
        `SELECT id FROM documents
          WHERE status = 'archived'
             OR scope_id NOT IN (${scopePlaceholders})
             OR sensitivity > ?
          ORDER BY updated_at`
      )
      .all(...ctx.scopeIds, ctx.clearance) as { id: string }[]

    const maxDocUpdated = docs.reduce((m, d) => Math.max(m, d.updatedAt), 0)
    const maxMemUpdated = memories.reduce(
      (m, x) => Math.max(m, Number(x.updatedAt ?? 0)),
      0
    )
    const pageBoundaries: number[] = []
    if (docsHasMore && docs.length > 0) pageBoundaries.push(docs[docs.length - 1].updatedAt)
    if (memoriesHasMore && memories.length > 0) {
      pageBoundaries.push(Number(memories[memories.length - 1].updatedAt))
    }
    if (revokedMemoriesHasMore && revokedMemories.length > 0) {
      pageBoundaries.push(revokedMemories[revokedMemories.length - 1].updatedAt)
    }
    // 有下一页时只推进到本页边界;全部拉完后才推进到当前时间。
    // 旧实现每页都 Date.now(),会把 limit 之外的剩余数据永久跳过。
    const nextCursor = pageBoundaries.length > 0 ? Math.min(...pageBoundaries) : snapshotCursor

    db.prepare(
      `INSERT INTO sync_cursors (user_id, device_id, cursor, synced_at)
       VALUES (?,?,?,?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET
         cursor = excluded.cursor, synced_at = excluded.synced_at`
    ).run(claims.sub, deviceId, nextCursor, Date.now())

    // revokedDocs 已在每次响应中完整下发,无需参与分页;记忆撤销仍走 cursor。
    const revokedDocIds = revokedDocs.map((r) => r.id)
    const revokedMemIds = revokedMemories.map((r) => r.id)
    const hasMore =
      docsHasMore || memoriesHasMore || revokedMemoriesHasMore

    app.audit(req, 'sync', undefined, {
      deviceId,
      cursor,
      docs: docs.length,
      memories: memories.length,
      revokedDocs: revokedDocIds.length,
      revokedMemories: revokedMemIds.length,
      purgeAll: ctx.scopeIds.length === 0
    })

    return reply.send(
      ok({
        nextCursor,
        docs: withChunks,
        memories,
        revokedDocs: revokedDocIds,
        revokedMemories: revokedMemIds,
        purgeAll: false,
        hasMore,
        // 调试与诊断:把 max 行时间一并返回,前端不必再算。
        _diagnostics: { maxDocUpdated, maxMemUpdated }
      })
    )
  })
}
