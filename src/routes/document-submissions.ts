import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthedRequest, requireCurator } from '../auth/jwt.js'
import { canAccessScope, loadAccessContext } from '../auth/scopes.js'
import { createDocumentFamily } from '../dao/documents.js'
import { sourceTypeFromName, SUPPORTED_EXTENSIONS } from '../kb/ingest/parse.js'
import { enqueueIngest } from '../kb/ingest/worker.js'
import { fail, ok } from '../reply.js'

const ReviewSchema = z.object({ note: z.string().max(2000).optional() })

interface SubmissionRow {
  id: string
  submitterId: string
  targetScope: string
  title: string
  sourceType: string
  storageKey: string
  contentHash: string
  byteSize: number
  sensitivity: number
  volatility: 'stable' | 'volatile'
  tagsJson: string | null
  state: string
}

function readTags(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((v) => v.trim()).filter(Boolean))].slice(0, 50)
}

function createDocumentFromSubmission(
  app: FastifyInstance,
  row: SubmissionRow,
  now = Date.now()
): string {
  const { db } = app.deps
  const docId = randomUUID()
  db.transaction(() => {
    const familyId = createDocumentFamily(db, {
      scopeId: row.targetScope,
      title: row.title,
      ownerId: row.submitterId,
      now
    })
    db.prepare(
      `INSERT INTO documents
         (id, scope_id, title, source_type, storage_key, content_hash, byte_size,
          owner_id, sensitivity, volatility, status, family_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`
    ).run(
      docId,
      row.targetScope,
      row.title,
      row.sourceType,
      row.storageKey,
      row.contentHash,
      row.byteSize,
      row.submitterId,
      row.sensitivity,
      row.volatility,
      familyId,
      now,
      now
    )
    const tags = row.tagsJson ? (JSON.parse(row.tagsJson) as string[]) : []
    for (const tag of tags) {
      db.prepare('INSERT OR IGNORE INTO doc_tags (doc_id, tag) VALUES (?,?)').run(docId, tag)
    }
  })()
  enqueueIngest(db, docId)
  return docId
}

export function registerDocumentSubmissionRoutes(app: FastifyInstance): void {
  const { db, cfg, storage } = app.deps

  /**
   * 统一文件入口：
   * - 自己的 personal scope：直接创建文档并摄取；
   * - curator/admin：对可管理的组织空间直接发布；
   * - member -> team/org：仅创建 pending submission，不进入检索。
   */
  app.post(
    '/api/v1/document-submissions',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const data = await req.file({ limits: { fileSize: cfg.maxUploadBytes } })
      if (!data) return reply.code(400).send(fail(4001, '缺少文件'))
      const fields = data.fields as Record<string, { value?: string } | undefined>
      const targetScope = fields.scopeId?.value
      if (!targetScope) return reply.code(400).send(fail(4001, '缺少 scopeId'))

      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      if (!canAccessScope(ctx, targetScope)) {
        return reply.code(403).send(fail(4033, '无权向该范围提交文档'))
      }
      const scope = db
        .prepare(
          `SELECT kind, owner_user_id AS ownerUserId FROM v_effective_scopes WHERE id = ?`
        )
        .get(targetScope) as { kind: 'personal' | 'team' | 'org'; ownerUserId: string | null } | undefined
      if (!scope) return reply.code(400).send(fail(4001, '目标 scope 不存在'))
      if (scope.kind === 'personal' && scope.ownerUserId !== claims.sub) {
        return reply.code(403).send(fail(4033, '不能向他人个人空间提交文档'))
      }

      const fileName = data.filename ?? 'untitled'
      const sourceType = sourceTypeFromName(fileName)
      if (!sourceType) {
        return reply
          .code(415)
          .send(fail(4151, `不支持的文件类型，当前支持: ${SUPPORTED_EXTENSIONS.join(' ')}`))
      }
      const buf = await data.toBuffer()
      if (data.file.truncated) {
        return reply
          .code(413)
          .send(fail(4131, `文件超过上限 ${Math.floor(cfg.maxUploadBytes / 1048576)}MB`))
      }

      const contentHash = createHash('sha256').update(buf).digest('hex')
      const published = db
        .prepare(
          `SELECT id, status FROM documents
            WHERE scope_id = ? AND content_hash = ? AND status != 'archived'
            ORDER BY created_at DESC LIMIT 1`
        )
        .get(targetScope, contentHash) as { id: string; status: string } | undefined
      if (published) {
        return reply.send(ok({
          submissionId: null,
          docId: published.id,
          state: 'approved',
          documentStatus: published.status,
          dedup: true
        }))
      }

      const duplicate = db
        .prepare(
          `SELECT id FROM document_submissions
            WHERE submitter_id = ? AND target_scope = ? AND content_hash = ? AND state = 'pending'
            LIMIT 1`
        )
        .get(claims.sub, targetScope, contentHash) as { id: string } | undefined
      if (duplicate) {
        return reply.send(ok({ submissionId: duplicate.id, docId: null, state: 'pending', dedup: true }))
      }

      const ext = fileName.slice(fileName.lastIndexOf('.') + 1)
      const storageKey = await storage.put(buf, ext)
      const now = Date.now()
      const id = randomUUID()
      const title = fields.title?.value?.trim() || fileName
      const sensitivity = Math.max(0, Math.min(2, Number(fields.sensitivity?.value ?? 0)))
      const volatility = fields.volatility?.value === 'volatile' ? 'volatile' : 'stable'
      const tags = readTags(fields.tags?.value)
      const autoApprove = scope.kind === 'personal' || claims.role !== 'member'

      const submission: SubmissionRow = {
        id,
        submitterId: claims.sub,
        targetScope,
        title,
        sourceType,
        storageKey,
        contentHash,
        byteSize: buf.length,
        sensitivity,
        volatility,
        tagsJson: JSON.stringify(tags),
        state: autoApprove ? 'approved' : 'pending'
      }

      let docId: string | null = null
      db.prepare(
        `INSERT INTO document_submissions
           (id, submitter_id, target_scope, title, source_type, storage_key, content_hash,
            byte_size, sensitivity, volatility, tags_json, state, reviewer_id,
            reviewed_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        claims.sub,
        targetScope,
        title,
        sourceType,
        storageKey,
        contentHash,
        buf.length,
        sensitivity,
        volatility,
        submission.tagsJson,
        submission.state,
        autoApprove ? claims.sub : null,
        autoApprove ? now : null,
        now
      )
      if (autoApprove) {
        docId = createDocumentFromSubmission(app, submission, now)
        db.prepare('UPDATE document_submissions SET result_document_id = ? WHERE id = ?').run(docId, id)
      }

      app.audit(req, autoApprove ? 'upload' : 'document_submit', id, {
        targetScope,
        scopeKind: scope.kind,
        docId,
        bytes: buf.length
      })
      return reply.send(ok({
        submissionId: id,
        docId,
        state: submission.state,
        documentStatus: docId ? 'pending' : null,
        dedup: false
      }))
    }
  )

  app.get('/api/v1/document-submissions/mine', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const rows = db.prepare(
      `SELECT ds.id, ds.title, ds.source_type AS sourceType, ds.byte_size AS byteSize,
              ds.state, ds.review_note AS reviewNote,
              ds.result_document_id AS resultDocumentId,
              ds.created_at AS createdAt, ds.reviewed_at AS reviewedAt,
              s.id AS scopeId, s.name AS scopeName, s.kind AS scopeKind,
              r.display_name AS reviewerName
         FROM document_submissions ds
         JOIN v_effective_scopes s ON s.id = ds.target_scope
         LEFT JOIN users r ON r.id = ds.reviewer_id
        WHERE ds.submitter_id = ?
        ORDER BY ds.created_at DESC LIMIT 100`
    ).all(claims.sub)
    return reply.send(ok(rows))
  })

  app.get(
    '/api/v1/document-submissions',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      const requestedState = String((req.query as { state?: string }).state ?? 'pending')
      if (!['pending', 'approved', 'rejected', 'withdrawn'].includes(requestedState)) {
        return reply.code(400).send(fail(4001, '非法的 state'))
      }
      const where = ['ds.state = ?']
      const params: unknown[] = [requestedState]
      if (claims.role !== 'admin') {
        if (ctx.scopeIds.length === 0) return reply.send(ok([]))
        where.push(`ds.target_scope IN (${ctx.scopeIds.map(() => '?').join(',')})`)
        params.push(...ctx.scopeIds)
      }
      const rows = db.prepare(
        `SELECT ds.id, ds.title, ds.source_type AS sourceType, ds.byte_size AS byteSize,
                ds.sensitivity, ds.volatility, ds.tags_json AS tagsJson, ds.state,
                ds.created_at AS createdAt, ds.target_scope AS targetScope,
                s.name AS scopeName, s.kind AS scopeKind,
                u.id AS submitterId, u.display_name AS submitterName
           FROM document_submissions ds
           JOIN v_effective_scopes s ON s.id = ds.target_scope
           JOIN users u ON u.id = ds.submitter_id
          WHERE ${where.join(' AND ')}
          ORDER BY ds.created_at LIMIT 200`
      ).all(...params) as Record<string, unknown>[]
      return reply.send(ok(rows.map((row) => ({
        ...row,
        tags: typeof row.tagsJson === 'string' ? JSON.parse(row.tagsJson) : [],
        tagsJson: undefined
      }))))
    }
  )

  app.get(
    '/api/v1/document-submissions/:id/raw',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      const id = (req.params as { id: string }).id
      const row = db.prepare(
        `SELECT target_scope AS targetScope, title, source_type AS sourceType,
                storage_key AS storageKey
           FROM document_submissions WHERE id = ?`
      ).get(id) as {
        targetScope: string
        title: string
        sourceType: string
        storageKey: string
      } | undefined
      if (!row || (claims.role !== 'admin' && !canAccessScope(ctx, row.targetScope))) {
        return reply.code(404).send(fail(4041, '提交不存在或无权访问'))
      }
      const buf = await storage.get(row.storageKey)
      app.audit(req, 'document_review_download', id)
      return reply
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}`)
        .header('content-type', 'application/octet-stream')
        .header('x-content-type-options', 'nosniff')
        .send(buf)
    }
  )

  app.post(
    '/api/v1/document-submissions/:id/approve',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const parsed = ReviewSchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      const id = (req.params as { id: string }).id
      const row = db.prepare(
        `SELECT id, submitter_id AS submitterId, target_scope AS targetScope, title,
                source_type AS sourceType, storage_key AS storageKey,
                content_hash AS contentHash, byte_size AS byteSize, sensitivity,
                volatility, tags_json AS tagsJson, state
           FROM document_submissions WHERE id = ?`
      ).get(id) as SubmissionRow | undefined
      if (!row) return reply.code(404).send(fail(4041, '提交不存在'))
      if (row.state !== 'pending') return reply.code(409).send(fail(4093, `该提交已处理(${row.state})`))
      if (claims.role !== 'admin' && !canAccessScope(ctx, row.targetScope)) {
        return reply.code(403).send(fail(4034, '无权审核该范围的提交'))
      }

      const existing = db.prepare(
        `SELECT id, status FROM documents
          WHERE scope_id = ? AND content_hash = ? AND status != 'archived'
          ORDER BY created_at DESC LIMIT 1`
      ).get(row.targetScope, row.contentHash) as { id: string; status: string } | undefined
      const now = Date.now()
      const docId = existing?.id ?? createDocumentFromSubmission(app, row, now)
      db.prepare(
        `UPDATE document_submissions
            SET state='approved', reviewer_id=?, review_note=?, result_document_id=?, reviewed_at=?
          WHERE id=? AND state='pending'`
      ).run(claims.sub, parsed.data.note ?? null, docId, now, id)
      app.audit(req, 'approve', id, { kind: 'document', docId, dedup: !!existing })
      return reply.send(ok({ state: 'approved', docId, documentStatus: existing?.status ?? 'pending' }))
    }
  )

  app.post(
    '/api/v1/document-submissions/:id/reject',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const parsed = z.object({ note: z.string().min(1).max(2000) }).safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(4001, '请说明驳回原因'))
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)
      const id = (req.params as { id: string }).id
      const row = db.prepare(
        'SELECT target_scope AS targetScope, state FROM document_submissions WHERE id = ?'
      ).get(id) as { targetScope: string; state: string } | undefined
      if (!row) return reply.code(404).send(fail(4041, '提交不存在'))
      if (row.state !== 'pending') return reply.code(409).send(fail(4093, `该提交已处理(${row.state})`))
      if (claims.role !== 'admin' && !canAccessScope(ctx, row.targetScope)) {
        return reply.code(403).send(fail(4034, '无权审核该范围的提交'))
      }
      db.prepare(
        `UPDATE document_submissions SET state='rejected', reviewer_id=?, review_note=?, reviewed_at=?
          WHERE id=? AND state='pending'`
      ).run(claims.sub, parsed.data.note, Date.now(), id)
      app.audit(req, 'reject', id, { kind: 'document' })
      return reply.send(ok({ state: 'rejected' }))
    }
  )

  app.post(
    '/api/v1/document-submissions/:id/withdraw',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const claims = (req as AuthedRequest).claims
      const id = (req.params as { id: string }).id
      const info = db.prepare(
        `UPDATE document_submissions SET state='withdrawn', reviewed_at=?
          WHERE id=? AND submitter_id=? AND state='pending'`
      ).run(Date.now(), id, claims.sub)
      if (info.changes === 0) return reply.code(404).send(fail(4041, '提交不存在或已处理'))
      app.audit(req, 'document_withdraw', id)
      return reply.send(ok({ state: 'withdrawn' }))
    }
  )
}
