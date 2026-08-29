import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { loadAccessContext } from '../auth/scopes.js'
import type { AuthedRequest } from '../auth/jwt.js'

/**
 * Incremental offline-cache feed.
 *
 * A single timestamp is not a safe pagination cursor: documents and memories
 * are independent streams and many rows can share the same millisecond. V2
 * therefore carries a keyset position (time + stable id) per stream. Completed
 * snapshots collapse back to a small baseline cursor, so the next poll starts
 * a fresh snapshot instead of being stuck on the previous upper bound.
 */

const SyncQuery = z.object({
  cursor: z.string().default('0'),
  deviceId: z.string().min(1).default('default'),
  limit: z.coerce.number().int().min(1).max(500).default(200)
})

const HOT_WINDOW_MS = 30 * 24 * 3600_000
const END_ID = '\uffff'

interface Position {
  t: number
  id: string
}

interface ActiveCursor {
  v: 2
  since: number
  snapshot: number
  docs: Position
  memories: Position
  revokedMemories: Position
}

interface BaselineCursor {
  v: 2
  since: number
}

function decodeCursor(raw: string, snapshot: number): ActiveCursor {
  const legacy = Number(raw)
  if (Number.isSafeInteger(legacy) && legacy >= 0) {
    const pos = { t: legacy, id: '' }
    return { v: 2, since: legacy, snapshot, docs: pos, memories: pos, revokedMemories: pos }
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as
      | ActiveCursor
      | BaselineCursor
    if (parsed.v !== 2 || !Number.isSafeInteger(parsed.since) || parsed.since < 0) throw new Error()
    if (!('snapshot' in parsed)) {
      const pos = { t: parsed.since, id: '' }
      return { v: 2, since: parsed.since, snapshot, docs: pos, memories: pos, revokedMemories: pos }
    }
    const validPos = (p: Position): boolean =>
      !!p && Number.isSafeInteger(p.t) && p.t >= parsed.since && typeof p.id === 'string'
    if (
      !Number.isSafeInteger(parsed.snapshot) ||
      parsed.snapshot < parsed.since ||
      !validPos(parsed.docs) ||
      !validPos(parsed.memories) ||
      !validPos(parsed.revokedMemories)
    ) throw new Error()
    return parsed
  } catch {
    throw new Error('invalid cursor')
  }
}

function encodeCursor(value: ActiveCursor | BaselineCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function nextPosition<T extends { syncAt: number; id: string }>(
  rows: T[],
  hasMore: boolean,
  snapshot: number
): Position {
  if (!hasMore) return { t: snapshot, id: END_ID }
  const last = rows[rows.length - 1]
  return { t: last.syncAt, id: last.id }
}

export function registerSyncRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  app.get('/api/v1/sync', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = SyncQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '查询参数错误'))
    const { deviceId, limit } = parsed.data
    const now = Date.now()
    let cursor: ActiveCursor
    try {
      cursor = decodeCursor(parsed.data.cursor, now)
    } catch {
      return reply.code(400).send(fail(4002, '同步游标无效'))
    }

    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)

    if (ctx.scopeIds.length === 0) {
      const nextCursor = encodeCursor({ v: 2, since: now })
      db.prepare(
        `INSERT INTO sync_cursors (user_id, device_id, cursor, synced_at)
         VALUES (?,?,?,?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET
           cursor = excluded.cursor, synced_at = excluded.synced_at`
      ).run(claims.sub, deviceId, nextCursor, now)
      return reply.send(ok({
        nextCursor,
        docs: [], memories: [], revokedDocs: [], revokedMemories: [],
        purgeAll: true, hasMore: false
      }))
    }

    const placeholders = ctx.scopeIds.map(() => '?').join(',')
    const hotSince = cursor.snapshot - HOT_WINDOW_MS

    // Hot means recently changed, recently cited, or small enough to cache.
    // lastCitedAt participates in syncAt, so an old document becoming hot is
    // delivered even though documents.updated_at itself did not change.
    const docRows = db.prepare(
      `WITH candidates AS (
         SELECT d.id, d.title, d.source_type AS sourceType, d.updated_at AS updatedAt,
                s.kind AS scopeKind,
                (SELECT COUNT(*) FROM chunks cc WHERE cc.doc_id = d.id) AS chunkCount,
                COALESCE((
                  SELECT MAX(q.created_at)
                    FROM qa_events q, json_each(q.cited_chunks) cited
                    JOIN chunks qc ON qc.id = cited.value
                   WHERE qc.doc_id = d.id
                ), 0) AS lastCitedAt
           FROM documents d
           LEFT JOIN document_families df ON df.id = d.family_id
           JOIN v_effective_scopes s ON s.id = d.scope_id
          WHERE d.scope_id IN (${placeholders})
            AND d.sensitivity <= ? AND d.status = 'ready'
            AND (d.family_id IS NULL OR
                 (df.current_document_id = d.id AND df.state = 'active'))
       )
       SELECT *, MAX(updatedAt, lastCitedAt) AS syncAt
         FROM candidates
        WHERE (updatedAt >= ? OR lastCitedAt >= ? OR chunkCount <= 20)
          AND (MAX(updatedAt, lastCitedAt) > ?
               OR (MAX(updatedAt, lastCitedAt) = ? AND id > ?))
          AND MAX(updatedAt, lastCitedAt) <= ?
        ORDER BY syncAt, id
        LIMIT ?`
    ).all(
      ...ctx.scopeIds, ctx.clearance,
      hotSince, hotSince,
      cursor.docs.t, cursor.docs.t, cursor.docs.id,
      cursor.snapshot, limit + 1
    ) as Array<{
      id: string; title: string; sourceType: string; updatedAt: number
      scopeKind: string; syncAt: number
    }>
    const docsHasMore = docRows.length > limit
    const docsPage = docRows.slice(0, limit)
    const chunkStmt = db.prepare(
      `SELECT id AS chunkId, text, heading, loc_page AS locPage,
              loc_start_ms AS locStartMs, modality
         FROM chunks WHERE doc_id = ? ORDER BY seq`
    )
    const docs = docsPage.map(({ id, syncAt: _syncAt, ...d }) => ({
      docId: id,
      ...d,
      chunks: chunkStmt.all(id) as Record<string, unknown>[]
    }))

    const memoryRows = db.prepare(
      `SELECT m.id, m.kind, m.content, m.confidence, m.updated_at AS updatedAt,
              m.updated_at AS syncAt, s.kind AS scopeKind
         FROM org_memories m JOIN v_effective_scopes s ON s.id = m.scope_id
        WHERE m.scope_id IN (${placeholders}) AND m.status = 'active'
          AND (m.updated_at > ? OR (m.updated_at = ? AND m.id > ?))
          AND m.updated_at <= ?
        ORDER BY m.updated_at, m.id LIMIT ?`
    ).all(
      ...ctx.scopeIds,
      cursor.memories.t, cursor.memories.t, cursor.memories.id,
      cursor.snapshot, limit + 1
    ) as Array<Record<string, unknown> & { id: string; syncAt: number }>
    const memoriesHasMore = memoryRows.length > limit
    const memoryPage = memoryRows.slice(0, limit)
    const memories = memoryPage.map(({ syncAt: _syncAt, ...m }) => m)

    const revokedRows = db.prepare(
      `SELECT m.id, m.updated_at AS syncAt
         FROM org_memories m
        WHERE m.scope_id IN (${placeholders})
          AND m.status IN ('retired','superseded')
          AND (m.updated_at > ? OR (m.updated_at = ? AND m.id > ?))
          AND m.updated_at <= ?
        ORDER BY m.updated_at, m.id LIMIT ?`
    ).all(
      ...ctx.scopeIds,
      cursor.revokedMemories.t, cursor.revokedMemories.t, cursor.revokedMemories.id,
      cursor.snapshot, limit + 1
    ) as Array<{ id: string; syncAt: number }>
    const revokedMemoriesHasMore = revokedRows.length > limit
    const revokedPage = revokedRows.slice(0, limit)

    // Revocations are intentionally complete on every page: permission changes
    // need not modify document timestamps and stale local access is unacceptable.
    const revokedDocs = db.prepare(
      `SELECT id FROM documents
        WHERE status = 'archived' OR scope_id NOT IN (${placeholders}) OR sensitivity > ?
        ORDER BY id`
    ).all(...ctx.scopeIds, ctx.clearance) as { id: string }[]

    const hasMore = docsHasMore || memoriesHasMore || revokedMemoriesHasMore
    const activeNext: ActiveCursor = {
      ...cursor,
      docs: nextPosition(docsPage.map((d) => ({ id: d.id, syncAt: d.syncAt })), docsHasMore, cursor.snapshot),
      memories: nextPosition(memoryPage, memoriesHasMore, cursor.snapshot),
      revokedMemories: nextPosition(revokedPage, revokedMemoriesHasMore, cursor.snapshot)
    }
    const nextCursor = encodeCursor(
      hasMore ? activeNext : { v: 2, since: cursor.snapshot }
    )
    db.prepare(
      `INSERT INTO sync_cursors (user_id, device_id, cursor, synced_at)
       VALUES (?,?,?,?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET
         cursor = excluded.cursor, synced_at = excluded.synced_at`
    ).run(claims.sub, deviceId, nextCursor, now)

    const revokedDocIds = revokedDocs.map((r) => r.id)
    const revokedMemoryIds = revokedPage.map((r) => r.id)
    app.audit(req, 'sync', undefined, {
      deviceId, docs: docs.length, memories: memories.length,
      revokedDocs: revokedDocIds.length, revokedMemories: revokedMemoryIds.length
    })
    return reply.send(ok({
      nextCursor,
      docs,
      memories,
      revokedDocs: revokedDocIds,
      revokedMemories: revokedMemoryIds,
      purgeAll: false,
      hasMore
    }))
  })
}
