import { randomUUID } from 'node:crypto'
import type { DB } from '../../db/index.js'
import type { Embedder } from '../../models/embedder.js'
import { indexableText } from '../retrieve/text.js'
import type { ChunkDraft } from './chunk.js'

/**
 * 把分块结果写入三个存储:chunks(权威) + chunks_fts(BM25) + chunk_vectors(语义)。
 *
 * 三者必须原子写入。chunks_fts 是 contentless 表,它的 rowid 与 chunks.id
 * 没有天然关联,靠 embedding_meta.fts_rowid 建立映射 —— 漏写这一列会让
 * BM25 那一路完全查不到东西(join 不上),而且不报错。
 */

const EMBED_BATCH = 32

export interface IndexResult {
  chunkCount: number
  skipped: number
}

export function deleteChunks(db: DB, docId: string): void {
  // 先取 fts_rowid,删 FTS 行需要它(contentless 表要显式 delete)。
  const metas = db
    .prepare(
      `SELECT em.chunk_id AS chunkId, em.fts_rowid AS ftsRowid
         FROM embedding_meta em
         JOIN chunks c ON c.id = em.chunk_id
        WHERE c.doc_id = ?`
    )
    .all(docId) as { chunkId: string; ftsRowid: number | null }[]

  const delFts = db.prepare(
    "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, '')"
  )
  const delVec = db.prepare('DELETE FROM chunk_vectors WHERE chunk_id = ?')

  for (const m of metas) {
    if (m.ftsRowid != null) {
      try {
        delFts.run(m.ftsRowid)
      } catch {
        // contentless 表删除失败不阻断:chunks 行删掉后 join 不上,
        // 残留的 FTS 行不会再出现在结果里。
      }
    }
    delVec.run(m.chunkId)
  }
  // embedding_meta 与 chunks 由 FK CASCADE 清理。
  db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId)
}

export async function indexChunks(
  db: DB,
  docId: string,
  drafts: ChunkDraft[],
  embedder: Embedder,
  modelVersion: string
): Promise<IndexResult> {
  const doc = db
    .prepare('SELECT scope_id AS scopeId, sensitivity FROM documents WHERE id = ?')
    .get(docId) as { scopeId: string; sensitivity: number } | undefined
  if (!doc) throw new Error(`文档不存在: ${docId}`)

  deleteChunks(db, docId)
  if (drafts.length === 0) return { chunkCount: 0, skipped: 0 }

  const now = Date.now()
  const insChunk = db.prepare(`
    INSERT INTO chunks (id, doc_id, scope_id, sensitivity, seq, text, token_count,
                        loc_page, loc_start_ms, loc_end_ms, heading, modality, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)
  const insFts = db.prepare('INSERT INTO chunks_fts(text) VALUES (?)')
  const insVec = db.prepare(
    'INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)'
  )
  const insMeta = db.prepare(`
    INSERT INTO embedding_meta (chunk_id, model_version, fts_rowid, created_at)
    VALUES (?,?,?,?)
  `)

  let written = 0
  let skipped = 0

  // 分批嵌入:一次全量会在大文档上撑爆远端 API 的请求体上限。
  for (let start = 0; start < drafts.length; start += EMBED_BATCH) {
    const batch = drafts.slice(start, start + EMBED_BATCH)
    let vectors: number[][]
    try {
      vectors = await embedder.embedBatch(batch.map((d) => d.embedText))
    } catch (e) {
      // 嵌入失败不能让整篇文档白摄取:仍写 chunks 与 FTS,
      // 向量留空。后续可用 embedding_meta 的缺失来补建。
      vectors = []
    }

    // 事务边界放在批内:一批要么全写要么全不写,避免半批数据。
    db.transaction(() => {
      batch.forEach((draft, i) => {
        if (!draft.text.trim()) {
          skipped++
          return
        }
        const chunkId = randomUUID()
        const seq = start + i

        const ftsInfo = insFts.run(indexableText(draft.embedText))
        const ftsRowid = Number(ftsInfo.lastInsertRowid)

        insChunk.run(
          chunkId,
          docId,
          doc.scopeId,
          doc.sensitivity,
          seq,
          draft.text,
          draft.tokenCount,
          draft.page,
          draft.startMs,
          draft.endMs,
          draft.heading || null,
          draft.modality,
          now
        )
        insMeta.run(chunkId, modelVersion, ftsRowid, now)

        const vec = vectors[i]
        if (vec) insVec.run(chunkId, new Float32Array(vec))
        written++
      })
    })()
  }

  return { chunkCount: written, skipped }
}

/**
 * 摄取后置校验。
 *
 * 扫描件 PDF 没有文本层时,解析器会返回空内容但流程一路 ready —— 文档
 * 看起来正常,检索却永远命中不了。用"页数 vs chunk 数"的比例兜底:
 * 100 页只出 3 个 chunk 一定是解析出了问题。
 */
export function validateIngest(
  chunkCount: number,
  sourcePages: number | null
): { ok: boolean; reason?: string } {
  if (chunkCount === 0) {
    return { ok: false, reason: '未产出任何 chunk,可能是扫描件或空文档(需 OCR)' }
  }
  if (sourcePages && sourcePages >= 10 && chunkCount < sourcePages * 0.2) {
    return {
      ok: false,
      reason: `chunk 数异常偏少(${chunkCount} chunk / ${sourcePages} 页),疑似文本层缺失`
    }
  }
  return { ok: true }
}
