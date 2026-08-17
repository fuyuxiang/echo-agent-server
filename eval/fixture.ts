/**
 * Fixture 灌库。
 *
 * 直接走 HTTP 不可行:摄取 worker 的 embedder/reranker 默认是占位实现,
 * 文档会停在 pending 永远不 ready。因此本脚本通过 admin RPC:
 *   1. 创建/获取财务部、董事会两个团队 scope;
 *   2. 把 fixture 文本直接插入 documents/chunks/embedding_meta/chunks_fts;
 *   3. 让文档保持 ready 状态,绕过摄取流水线。
 *
 * 这样 eval 跑的是真实 SQL 检索链路(权限内联、BM25、向量召回、精排),
 * 只是 embedding 是 hash-dev、rerank 是 lexical-dev —— 但 Recall/Precision/
 * 权限/leak/no-answer 这些核心指标都能被验证。
 */

import { randomUUID } from 'node:crypto'
import { openDb } from '../src/db/index.js'
import { FIXTURE_DOCS, type FixtureDoc } from './fixture-data.js'

interface FixtureMeta {
  docId: string
  scopeId: string
  scopeKind: 'org' | 'team'
  title: string
  body: string
}

async function fixtureIntoDb(dbPath: string): Promise<void> {
  const db = openDb({ path: dbPath })

  // 1. 获取 org scope
  const orgRow = db.prepare("SELECT id FROM scopes WHERE kind='org'").get() as
    | { id: string }
    | undefined
  if (!orgRow) throw new Error('org scope 不存在,请确认 server 已首启')
  const orgScopeId = orgRow.id

  // 2. 创建/获取团队 scope —— 财务部、董事会
  const scopeFor = new Map<string, string>()
  scopeFor.set('org', orgScopeId)

  const ensureTeamScope = (name: string): string => {
    const existing = db
      .prepare(
        `SELECT s.id FROM scopes s
           LEFT JOIN groups g ON g.id = s.group_id
          WHERE s.kind='team' AND g.name = ?`
      )
      .get(name) as { id: string } | undefined
    if (existing) return existing.id
    const groupId = randomUUID()
    const scopeId = randomUUID()
    const now = Date.now()
    db.transaction(() => {
      db.prepare(
        'INSERT INTO groups (id, name, parent_id, description, created_at) VALUES (?,?,?,?,?)'
      ).run(groupId, name, null, `eval fixture - ${name}`, now)
      db.prepare(
        'INSERT INTO scopes (id, kind, group_id, name) VALUES (?,?,?,?)'
      ).run(scopeId, 'team', groupId, name)
    })()
    return scopeId
  }

  scopeFor.set('team:财务部', ensureTeamScope('财务部'))
  scopeFor.set('team:董事会', ensureTeamScope('董事会'))

  // 3. 灌库:每个 fixture doc → documents + chunks + chunks_fts + embedding_meta + chunk_vectors
  //    embedding_meta + chunk_vectors 让 hash-dev 的 vector 召回能命中。
  const insertOne = (doc: FixtureDoc): FixtureMeta => {
    const scopeId = scopeFor.get(doc.scope)
    if (!scopeId) throw new Error(`未找到 scope: ${doc.scope}`)
    const scopeKind: 'org' | 'team' = doc.scope === 'org' ? 'org' : 'team'

    const id = doc.docId
    const existing = db.prepare('SELECT id FROM documents WHERE id = ?').get(id) as
      | { id: string }
      | undefined
    if (!existing) {
      const now = Date.now()
      db.prepare(
        `INSERT INTO documents
           (id, scope_id, title, source_type, storage_key, content_hash, byte_size,
            owner_id, sensitivity, volatility, status, version, created_at, updated_at, indexed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'ready',1,?,?,?)`
      ).run(
        id,
        scopeId,
        doc.title,
        doc.sourceType,
        null,
        `eval-fixture-${id}`,
        Buffer.byteLength(doc.body, 'utf8'),
        null,
        0,
        'stable',
        now,
        now,
        now
      )
    }

    // 删除旧 chunks / fts / meta / vector 行,确保 fixture 重跑一致。
    // 注意 chunks_fts 是 contentless 虚表,DELETE 在虚表上无效。
    // 这里用先清 chunks,再靠 ON DELETE CASCADE 不会触发(没建),所以
    // 显式按 rowid 清 FTS 行;但 rowid 需要先查出来,这里直接清全部旧 chunks
    // 留下的 fts 行,然后重建 —— 由 embedding_meta 的 fts_rowid 同步。
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id)
    // 显式清掉此 doc 已有的 fts 行:用嵌入表反查。
    const oldFtsRows = db
      .prepare(
        `SELECT fts_rowid FROM embedding_meta
          WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)`
      )
      .all(id) as { fts_rowid: number }[]
    for (const r of oldFtsRows) {
      db.prepare('INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES (?,?,?)').run(
        'delete',
        r.fts_rowid,
        ''
      )
    }

    const paragraphs = doc.body
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    paragraphs.forEach((text, idx) => {
      const chunkId = `${id}-c${idx}`
      // chunk 自身
      const ins = db
        .prepare(
          `INSERT INTO chunks
             (id, doc_id, scope_id, sensitivity, seq, text, token_count, modality, created_at)
           VALUES (?,?,?,0,?,?,?,?,?)`
        )
        .run(chunkId, id, scopeId, idx, text, Math.max(1, Math.ceil(text.length / 4)), 'text', Date.now())
      const rowid = Number(ins.lastInsertRowid)

      // FTS5 contentless:仅由 rowid 关联
      db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?,?)').run(rowid, text)

      // embedding_meta:让 retriever 知道该 chunk 属于哪个 model_version。
      db.prepare(
        `INSERT OR REPLACE INTO embedding_meta (chunk_id, model_version, fts_rowid, created_at)
         VALUES (?,?,?,?)`
      ).run(chunkId, 'eval-fixture-hash', rowid, Date.now())

      // chunk_vectors:写 1024 维零向量,hash-dev embedder 与 BM25 共同检索。
      // 这里使用一个固定模式(每 docId 不同的小扰动)以便 hash-dev 距离不恒等。
      const dim = 1024
      const vec = new Float32Array(dim)
      // 用 chunkId 哈希生成种子,确保不同 doc 的向量不完全相同。
      let seed = 0
      for (let i = 0; i < chunkId.length; i++) seed = (seed * 31 + chunkId.charCodeAt(i)) >>> 0
      for (let i = 0; i < dim; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        vec[i] = ((seed / 0xffffffff) - 0.5) * 0.01
      }
      // 让第一维与 docId 弱相关,使 hash-dev 距离对不同 doc 不同。
      vec[0] = (seed % 100) / 100
      db.prepare('INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?,?)').run(
        chunkId,
        Buffer.from(vec.buffer)
      )
    })

    return { docId: id, scopeId, scopeKind, title: doc.title, body: doc.body }
  }

  const metas: FixtureMeta[] = []
  db.transaction(() => {
    for (const d of FIXTURE_DOCS) metas.push(insertOne(d))
  })()

  console.log(`[fixture] 灌库完成:共 ${metas.length} 篇文档`)
  for (const m of metas) {
    console.log(`  - ${m.docId}  scope=${m.scopeKind}  title=${m.title}`)
  }
  db.close()
}

async function main(): Promise<void> {
  const dbPath = process.env.ECHO_DB_PATH ?? '/tmp/echo-eval.db'
  await fixtureIntoDb(dbPath)
}

main().catch((e) => {
  console.error('[fixture] 失败:', e)
  process.exit(1)
})

export { fixtureIntoDb }
