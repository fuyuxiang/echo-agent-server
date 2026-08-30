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
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db/index.js'
import { FIXTURE_DOCS, type FixtureDoc } from './fixture-data.js'
import { indexableText } from '../src/kb/retrieve/text.js'

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
    // chunks_fts 是 contentless 虚表，必须在删 chunks 前保存 rowid，
    // 再用 FTS5 的 delete 命令显式清理。
    // 先保存 FTS rowid，再删 chunks。如果先删 chunks，下面的子查询
    // 将永返回空集，fixture 重跑会残留幽灵索引项。
    const oldFtsRows = db
      .prepare(
        `SELECT fts_rowid FROM embedding_meta
          WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)`
      )
      .all(id) as { fts_rowid: number }[]
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id)
    for (const r of oldFtsRows) {
      db.prepare('INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES (?,?,?)').run(
        'delete',
        r.fts_rowid,
        ''
      )
    }

    // 与生产 Markdown 摄取对齐：标题不单独成 chunk，而是作为后续
    // 正文的 heading 元数据参与检索和引用。
    const paragraphs: Array<{ text: string; heading: string }> = []
    const headingStack: Array<{ level: number; text: string }> = []
    for (const rawParagraph of doc.body.split(/\n\s*\n/)) {
      const bodyLines: string[] = []
      for (const line of rawParagraph.trim().split('\n')) {
        const match = /^(#{1,6})[ \t]+(.+)$/.exec(line.trim())
        if (match) {
          const level = match[1].length
          while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
            headingStack.pop()
          }
          headingStack.push({ level, text: match[2].trim() })
        } else if (line.trim().length > 0) {
          bodyLines.push(line.trim())
        }
      }
      const text = bodyLines.join('\n').trim()
      if (text.length > 0) {
        paragraphs.push({ text, heading: headingStack.map((h) => h.text).join(' > ') })
      }
    }

    paragraphs.forEach(({ text, heading }, idx) => {
      const chunkId = `${id}-c${idx}`
      // chunk 自身
      const ins = db
        .prepare(
          `INSERT INTO chunks
             (id, doc_id, scope_id, sensitivity, seq, text, token_count, heading, modality, created_at)
           VALUES (?,?,?,0,?,?,?,?,?,?)`
        )
        .run(
          chunkId,
          id,
          scopeId,
          idx,
          text,
          Math.max(1, Math.ceil(text.length / 4)),
          heading,
          'text',
          Date.now()
        )
      const rowid = Number(ins.lastInsertRowid)

      // FTS5 contentless:仅由 rowid 关联
      db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?,?)').run(rowid, indexableText(text))

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

// 仅作为 CLI 执行时灌库。被 Vitest/其他模块导入时不应产生
// 隐式数据库写入或 process.exit 副作用。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('[fixture] 失败:', e)
    process.exit(1)
  })
}

export { fixtureIntoDb }
