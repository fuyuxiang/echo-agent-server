import { randomUUID, createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { requireCurator, type AuthedRequest } from '../auth/jwt.js'
import { loadAccessContext, canAccessScope, canAccessDocument } from '../auth/scopes.js'
import { enqueueIngest } from '../kb/ingest/worker.js'
import { deleteChunks } from '../kb/ingest/indexer.js'
import { sourceTypeFromName, SUPPORTED_EXTENSIONS } from '../kb/ingest/parse.js'

const ListQuery = z.object({
  scopeId: z.string().optional(),
  status: z.string().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20)
})

const PatchSchema = z.object({
  title: z.string().min(1).optional(),
  scopeId: z.string().optional(),
  sensitivity: z.coerce.number().int().min(0).max(2).optional(),
  volatility: z.enum(['stable', 'volatile']).optional(),
  ownerId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional()
})

export function registerDocsRoutes(app: FastifyInstance): void {
  const { db, cfg, storage } = app.deps

  /**
   * 上传。
   *
   * 去重按 (scope_id, content_hash):同一份文件在不同 scope 下是两份
   * 独立文档(可见范围不同),不能合并。
   */
  app.post(
    '/api/v1/docs/upload',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const data = await req.file({ limits: { fileSize: cfg.maxUploadBytes } })
      if (!data) return reply.code(400).send(fail(4001, '缺少文件'))

      const fields = data.fields as Record<string, { value?: string } | undefined>
      const scopeId = fields.scopeId?.value
      if (!scopeId) return reply.code(400).send(fail(4001, '缺少 scopeId'))

      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      // 管理员可写任意 scope;curator 只能写自己可见的范围。
      if (claims.role !== 'admin' && !canAccessScope(ctx, scopeId)) {
        return reply.code(403).send(fail(4032, '无权向该范围上传'))
      }

      const fileName = data.filename ?? 'untitled'
      const sourceType = sourceTypeFromName(fileName)
      if (!sourceType) {
        return reply
          .code(415)
          .send(fail(4151, `不支持的文件类型,当前支持: ${SUPPORTED_EXTENSIONS.join(' ')}`))
      }

      const buf = await data.toBuffer()
      if (data.file.truncated) {
        return reply
          .code(413)
          .send(fail(4131, `文件超过上限 ${Math.floor(cfg.maxUploadBytes / 1048576)}MB`))
      }

      const hash = createHash('sha256').update(buf).digest('hex')
      const existing = db
        .prepare(
          `SELECT id, status FROM documents
            WHERE content_hash = ? AND scope_id = ? AND status != 'archived'`
        )
        .get(hash, scopeId) as { id: string; status: string } | undefined
      if (existing) {
        return reply.send(
          ok({ docId: existing.id, status: existing.status, dedup: true })
        )
      }

      const ext = fileName.slice(fileName.lastIndexOf('.') + 1)
      const storageKey = await storage.put(buf, ext)
      const docId = randomUUID()
      const now = Date.now()
      const title = fields.title?.value?.trim() || fileName

      db.prepare(
        `INSERT INTO documents (id, scope_id, title, source_type, storage_key, content_hash,
                                byte_size, owner_id, sensitivity, volatility, status,
                                created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
      ).run(
        docId,
        scopeId,
        title,
        sourceType,
        storageKey,
        hash,
        buf.length,
        fields.ownerId?.value ?? claims.sub,
        Number(fields.sensitivity?.value ?? 0),
        fields.volatility?.value === 'volatile' ? 'volatile' : 'stable',
        now,
        now
      )

      const tags = fields.tags?.value
      if (tags) {
        for (const tag of tags.split(',').map((t) => t.trim()).filter(Boolean)) {
          db.prepare('INSERT OR IGNORE INTO doc_tags (doc_id, tag) VALUES (?,?)').run(docId, tag)
        }
      }

      enqueueIngest(db, docId)
      app.audit(req, 'upload', docId, { title, scopeId, bytes: buf.length })
      return reply.send(ok({ docId, status: 'pending', dedup: false }))
    }
  )

  app.get('/api/v1/docs', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '查询参数错误'))
    const { scopeId, status, q, page, size } = parsed.data

    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    if (ctx.scopeIds.length === 0) return reply.send(ok({ items: [], total: 0, page, size }))

    // 列表同样受 scope 与密级限制 —— 否则可以从标题里推断出机密文档的存在。
    const where: string[] = [
      `d.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})`,
      'd.sensitivity <= ?'
    ]
    const params: unknown[] = [...ctx.scopeIds, ctx.clearance]

    if (scopeId) {
      where.push('d.scope_id = ?')
      params.push(scopeId)
    }
    if (status) {
      where.push('d.status = ?')
      params.push(status)
    } else {
      where.push("d.status != 'archived'")
    }
    if (q) {
      where.push('d.title LIKE ?')
      params.push(`%${q}%`)
    }

    const whereSql = where.join(' AND ')
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM documents d WHERE ${whereSql}`)
        .get(...params) as { n: number }
    ).n

    const items = db
      .prepare(
        `SELECT d.id, d.title, d.source_type AS sourceType, d.status, d.fail_reason AS failReason,
                d.byte_size AS byteSize, d.sensitivity, d.volatility, d.version,
                d.created_at AS createdAt, d.updated_at AS updatedAt, d.indexed_at AS indexedAt,
                s.kind AS scopeKind, s.name AS scopeName, s.id AS scopeId,
                u.display_name AS ownerName,
                (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunkCount
           FROM documents d
           JOIN scopes s ON s.id = d.scope_id
           LEFT JOIN users u ON u.id = d.owner_id
          WHERE ${whereSql}
          ORDER BY d.updated_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, size, (page - 1) * size)

    return reply.send(ok({ items, total, page, size }))
  })

  app.get('/api/v1/docs/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    // 按 id 读取必须单独校验:不走检索链路,否则可以靠猜 id 绕过 scope。
    if (!canAccessDocument(db, ctx, id)) {
      return reply.code(404).send(fail(4041, '文档不存在或无权访问'))
    }

    const doc = db
      .prepare(
        `SELECT d.*, s.kind AS scopeKind, s.name AS scopeName, u.display_name AS ownerName
           FROM documents d
           JOIN scopes s ON s.id = d.scope_id
           LEFT JOIN users u ON u.id = d.owner_id
          WHERE d.id = ?`
      )
      .get(id) as Record<string, unknown>
    const tags = db.prepare('SELECT tag FROM doc_tags WHERE doc_id = ?').all(id) as {
      tag: string
    }[]
    const chunkCount = (
      db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?').get(id) as { n: number }
    ).n

    // 不回传 storage_key:内部路径没有对外价值,暴露只会方便探测。
    delete doc.storage_key
    return reply.send(ok({ ...doc, tags: tags.map((t) => t.tag), chunkCount }))
  })

  app.get('/api/v1/docs/:id/status', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    if (!canAccessDocument(db, ctx, id)) {
      return reply.code(404).send(fail(4041, '文档不存在或无权访问'))
    }

    const doc = db
      .prepare('SELECT status, fail_reason AS failReason FROM documents WHERE id = ?')
      .get(id) as { status: string; failReason: string | null }
    const job = db
      .prepare(
        `SELECT stage, state, attempts, last_error AS lastError
           FROM ingest_jobs WHERE doc_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(id) as Record<string, unknown> | undefined

    const STAGES = ['pending', 'parsing', 'chunking', 'embedding', 'ready']
    const idx = STAGES.indexOf(doc.status)
    return reply.send(
      ok({
        status: doc.status,
        failReason: doc.failReason,
        progress: doc.status === 'ready' ? 1 : idx < 0 ? 0 : idx / (STAGES.length - 1),
        job: job ?? null
      })
    )
  })

  /** 原始文件下载。权限校验不可省 —— 这是绕过检索直接取内容的路径。 */
  app.get('/api/v1/docs/:id/raw', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    if (!canAccessDocument(db, ctx, id)) {
      return reply.code(404).send(fail(4041, '文档不存在或无权访问'))
    }

    const doc = db
      .prepare('SELECT storage_key AS storageKey, title, source_type AS sourceType FROM documents WHERE id = ?')
      .get(id) as { storageKey: string; title: string; sourceType: string }
    if (!doc?.storageKey) return reply.code(404).send(fail(4042, '原始文件不存在'))

    const buf = await storage.get(doc.storageKey)
    // 强制下载而非内联渲染:HTML/SVG 内联会带来存储型 XSS。
    return reply
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.title)}`)
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .send(buf)
  })

  app.patch(
    '/api/v1/docs/:id',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const parsed = PatchSchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      if (claims.role !== 'admin' && !canAccessDocument(db, ctx, id)) {
        return reply.code(404).send(fail(4041, '文档不存在或无权访问'))
      }

      const v = parsed.data
      const sets: string[] = []
      const params: unknown[] = []
      if (v.title !== undefined) { sets.push('title = ?'); params.push(v.title) }
      if (v.scopeId !== undefined) { sets.push('scope_id = ?'); params.push(v.scopeId) }
      if (v.sensitivity !== undefined) { sets.push('sensitivity = ?'); params.push(v.sensitivity) }
      if (v.volatility !== undefined) { sets.push('volatility = ?'); params.push(v.volatility) }
      if (v.ownerId !== undefined) { sets.push('owner_id = ?'); params.push(v.ownerId) }

      db.transaction(() => {
        if (sets.length) {
          sets.push('updated_at = ?')
          params.push(Date.now())
          db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
        }
        // chunks 冗余了 scope_id/sensitivity 以免检索时 join,所以这里必须
        // 同步 —— 漏掉会让权限变更对已索引内容失效。
        if (v.scopeId !== undefined || v.sensitivity !== undefined) {
          db.prepare(
            `UPDATE chunks SET
               scope_id = (SELECT scope_id FROM documents WHERE id = ?),
               sensitivity = (SELECT sensitivity FROM documents WHERE id = ?)
             WHERE doc_id = ?`
          ).run(id, id, id)
        }
        if (v.tags) {
          db.prepare('DELETE FROM doc_tags WHERE doc_id = ?').run(id)
          for (const tag of v.tags) {
            db.prepare('INSERT OR IGNORE INTO doc_tags (doc_id, tag) VALUES (?,?)').run(id, tag)
          }
        }
      })()

      return reply.send(ok({ updated: true }))
    }
  )

  app.post(
    '/api/v1/docs/:id/reindex',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      if (claims.role !== 'admin' && !canAccessDocument(db, ctx, id)) {
        return reply.code(404).send(fail(4041, '文档不存在或无权访问'))
      }
      enqueueIngest(db, id)
      return reply.send(ok({ queued: true }))
    }
  )

  /**
   * 软删。
   *
   * 立即删除 chunk,让内容当场从检索中消失;documents 行保留为 archived,
   * 使引用历史与审计仍可追溯。
   */
  app.delete(
    '/api/v1/docs/:id',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      if (claims.role !== 'admin' && !canAccessDocument(db, ctx, id)) {
        return reply.code(404).send(fail(4041, '文档不存在或无权访问'))
      }

      db.transaction(() => {
        deleteChunks(db, id)
        db.prepare(
          "UPDATE documents SET status = 'archived', updated_at = ? WHERE id = ?"
        ).run(Date.now(), id)
        db.prepare("DELETE FROM ingest_jobs WHERE doc_id = ? AND state != 'done'").run(id)
      })()

      app.audit(req, 'delete', id)
      return reply.send(ok({ archived: true }))
    }
  )
}
