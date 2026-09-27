import type { DB } from '../db/index.js'

/** Bounded chunk reader shared by REST and MCP document views. */
export function readDocumentChunks(
  db: DB,
  docId: string,
  options: { page?: number | null; range?: string | null; afterSeq?: number | null; limit?: number } = {}
): { chunks: Array<{ id: string; seq: number; text: string; heading: string | null; locPage: number | null; locStartMs: number | null; locEndMs: number | null }>; hasMore: boolean; nextSeq: number | null } {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 200)
  const where = ['doc_id = ?']
  const params: unknown[] = [docId]
  if (options.page != null) {
    where.push('loc_page = ?')
    params.push(options.page)
  } else if (options.range) {
    const [first, last] = options.range.split(':').map(Number)
    where.push('seq BETWEEN ? AND ?')
    params.push(Math.max(0, Math.min(first, last)), Math.max(first, last))
  }
  if (options.afterSeq != null) {
    where.push('seq > ?')
    params.push(options.afterSeq)
  }
  const rows = db.prepare(
    `SELECT id, seq, text, heading, loc_page AS locPage,
            loc_start_ms AS locStartMs, loc_end_ms AS locEndMs
       FROM chunks WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`
  ).all(...params, limit + 1) as Array<{
    id: string; seq: number; text: string; heading: string | null
    locPage: number | null; locStartMs: number | null; locEndMs: number | null
  }>
  const chunks = rows.slice(0, limit)
  const lastSeq = chunks.at(-1)?.seq
  const hasMore = rows.length > limit || (lastSeq != null && options.range != null &&
    !!db.prepare('SELECT 1 FROM chunks WHERE doc_id=? AND seq>? LIMIT 1').get(docId, lastSeq))
  return { chunks, hasMore, nextSeq: hasMore && lastSeq != null ? lastSeq : null }
}
