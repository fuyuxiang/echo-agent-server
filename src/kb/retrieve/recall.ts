import type { DB } from '../../db/index.js'
import type { AccessContext } from '../../auth/scopes.js'
import { buildFtsQuery } from './text.js'

export interface Candidate {
  chunkId: string
  docId: string
  docTitle: string
  text: string
  heading: string | null
  locPage: number | null
  locStartMs: number | null
  locEndMs: number | null
  scopeKind: string
  modality: string
  sourceType: string
  ownerId: string | null
  ownerName: string | null
  volatility: string
  updatedAt: number
  /** 该路召回的原始名次,从 1 起。RRF 只用名次,不用分数。 */
  rank: number
}

// 两路各取 50 送入融合,融合后取 100 进精排。这两个数字来自
// "bi-encoder 宽召回 + cross-encoder 窄精排" 的常规配比。
export const RECALL_LIMIT = 50

// 所有检索 SQL 共用的字段列表与 join。
const SELECT_FIELDS = `
  c.id            AS chunkId,
  c.doc_id        AS docId,
  d.title         AS docTitle,
  c.text          AS text,
  c.heading       AS heading,
  c.loc_page      AS locPage,
  c.loc_start_ms  AS locStartMs,
  c.loc_end_ms    AS locEndMs,
  s.kind          AS scopeKind,
  c.modality      AS modality,
  d.source_type   AS sourceType,
  d.owner_id      AS ownerId,
  o.display_name  AS ownerName,
  d.volatility    AS volatility,
  d.updated_at    AS updatedAt
`

const JOINS = `
  JOIN documents d ON d.id = c.doc_id
  LEFT JOIN document_families df ON df.id = d.family_id
  JOIN v_effective_scopes s ON s.id = c.scope_id
  LEFT JOIN users o ON o.id = d.owner_id
`

/**
 * 权限强制点。
 *
 * scope 与 sensitivity 内联进 WHERE,未授权的 chunk 从不进入进程内存。
 * 先检索再过滤是错的:被排除的内容早已出现在内存、日志和(万一漏过滤)
 * 模型上下文里。chunks 表冗余了 scope_id/sensitivity 正是为了让这个
 * 条件不需要 join 就能生效。
 */
function accessClause(ctx: AccessContext): { sql: string; params: unknown[] } {
  const placeholders = ctx.scopeIds.map(() => '?').join(',')
  return {
    sql: `c.scope_id IN (${placeholders})
          AND c.sensitivity <= ?
          AND d.status = 'ready'
          AND (d.family_id IS NULL OR
               (df.current_document_id = d.id AND df.state = 'active'))`,
    params: [...ctx.scopeIds, ctx.clearance]
  }
}

export interface RecallFilters {
  tags?: string[]
  sourceTypes?: string[]
  scopeKinds?: string[]
}

function filterClause(f: RecallFilters | undefined): {
  sql: string
  params: unknown[]
} {
  const parts: string[] = []
  const params: unknown[] = []

  if (f?.sourceTypes?.length) {
    parts.push(`d.source_type IN (${f.sourceTypes.map(() => '?').join(',')})`)
    params.push(...f.sourceTypes)
  }
  if (f?.scopeKinds?.length) {
    parts.push(`s.kind IN (${f.scopeKinds.map(() => '?').join(',')})`)
    params.push(...f.scopeKinds)
  }
  if (f?.tags?.length) {
    parts.push(
      `EXISTS (SELECT 1 FROM doc_tags t
                WHERE t.doc_id = d.id
                  AND t.tag IN (${f.tags.map(() => '?').join(',')}))`
    )
    params.push(...f.tags)
  }

  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params }
}

/** BM25 全文召回。负责精确词:型号、缩写、工号、专有名词。 */
export function bm25Search(
  db: DB,
  query: string,
  ctx: AccessContext,
  limit = RECALL_LIMIT,
  filters?: RecallFilters
): Candidate[] {
  if (ctx.scopeIds.length === 0) return []
  const match = buildFtsQuery(query)
  if (!match) return []

  const access = accessClause(ctx)
  const filt = filterClause(filters)

  // chunks_fts 是 contentless 表,靠 embedding_meta.fts_rowid 回连 chunks。
  const sql = `
    SELECT ${SELECT_FIELDS}
      FROM chunks_fts f
      JOIN embedding_meta em ON em.fts_rowid = f.rowid
      JOIN chunks c ON c.id = em.chunk_id
      ${JOINS}
     WHERE chunks_fts MATCH ?
       AND ${access.sql}${filt.sql}
     ORDER BY bm25(chunks_fts)
     LIMIT ?
  `
  const rows = db
    .prepare(sql)
    .all(match, ...access.params, ...filt.params, limit) as Omit<
    Candidate,
    'rank'
  >[]

  return rows.map((r, i) => ({ ...r, rank: i + 1 }))
}

/** 向量召回。负责语义:换一种说法问同一件事。 */
export function vectorSearch(
  db: DB,
  queryVec: number[],
  ctx: AccessContext,
  limit = RECALL_LIMIT,
  filters?: RecallFilters
): Candidate[] {
  if (ctx.scopeIds.length === 0) return []

  const access = accessClause(ctx)
  const filt = filterClause(filters)

  // vec0 的 KNN 需要 k 常量与 MATCH 配合。权限条件同样内联 —— 注意这里
  // 必须在子查询外层过滤,vec0 虚表不支持任意 WHERE 下推。
  // 为避免权限过滤后不足 limit 条,KNN 先取 limit*4 的候选。
  const sql = `
    SELECT ${SELECT_FIELDS}, v.distance AS distance
      FROM (
        SELECT chunk_id, distance
          FROM chunk_vectors
         WHERE embedding MATCH ?
           AND k = ?
      ) v
      JOIN chunks c ON c.id = v.chunk_id
      ${JOINS}
     WHERE ${access.sql}${filt.sql}
     ORDER BY v.distance
     LIMIT ?
  `
  const rows = db
    .prepare(sql)
    .all(
      new Float32Array(queryVec),
      limit * 4,
      ...access.params,
      ...filt.params,
      limit
    ) as Omit<Candidate, 'rank'>[]

  return rows.map((r, i) => ({ ...r, rank: i + 1 }))
}

/** 组织记忆的 FTS 召回。记忆是提炼过的短陈述,与文档 chunk 分开检索。 */
export interface MemoryHit {
  id: string
  kind: string
  content: string
  scopeKind: string
  confidence: number
}

/**
 * 使用迁移维护的 FTS5 索引，先做文本相关性排序，再在权限
 * 和有效期条件内结合 confidence。
 */
export function searchMemories(
  db: DB,
  query: string,
  ctx: AccessContext,
  limit = 5
): MemoryHit[] {
  if (ctx.scopeIds.length === 0) return []
  const match = buildFtsQuery(query)
  if (!match) return []

  const placeholders = ctx.scopeIds.map(() => '?').join(',')
  const now = Date.now()

  const sql = `
    SELECT m.id, m.kind, m.content, s.kind AS scopeKind, m.confidence
      FROM org_memories_fts f
      JOIN org_memories m ON m.id=f.memory_id
      JOIN v_effective_scopes s ON s.id = m.scope_id
     WHERE org_memories_fts MATCH ?
       AND m.scope_id IN (${placeholders})
       AND m.status = 'active'
     ORDER BY
       CASE WHEN m.valid_until IS NOT NULL AND m.valid_until < ? THEN 1 ELSE 0 END,
       bm25(org_memories_fts),
       m.confidence DESC,
       m.hit_count DESC
     LIMIT ?
  `
  return db
    .prepare(sql)
    .all(
      match,
      ...ctx.scopeIds,
      now,
      limit
    ) as MemoryHit[]
}
