import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthedRequest, requireCurator } from '../auth/jwt.js'
import { canAccessScope, loadAccessContext } from '../auth/scopes.js'
import { createDocumentFamily } from '../dao/documents.js'
import { sourceTypeFromName, SUPPORTED_EXTENSIONS } from '../kb/ingest/parse.js'
import { enqueueIngest } from '../kb/ingest/worker.js'
import { fail, ok } from '../reply.js'
import { scanDocument, type ScanReport } from '../security/content-scanner.js'
import { sourceCapabilityError } from '../kb/ingest/capabilities.js'

const ReviewSchema = z.object({ note: z.string().max(2000).optional() })
const PublishCopySchema = z.object({
  targetScopeId: z.string().min(1),
  title: z.string().min(1).max(500).optional(),
  sensitivity: z.number().int().min(0).max(2).optional(),
  volatility: z.enum(['stable', 'volatile']).optional(),
  tags: z.array(z.string()).max(50).optional()
})

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
  scanStatus?: string
  scanReportJson?: string | null
  quarantineStorageKey?: string | null
  publishedStorageKey?: string | null
  sourceDocumentId?: string | null
}

function policyAllows(db: FastifyInstance['deps']['db'], column: string): boolean {
  const allowed = new Set(['allow_personal_cloud', 'allow_skill_submission'])
  if (!allowed.has(column)) return false
  const row = db.prepare(`SELECT ${column} AS enabled FROM enterprise_policy WHERE id='default'`).get() as
    | { enabled: number }
    | undefined
  return row?.enabled !== 0
}

function scanMessage(report: ScanReport): string {
  return report.findings
    .filter((item) => item.severity === 'high' || item.severity === 'critical')
    .map((item) => item.message)
    .join('；') || '技术扫描未通过'
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

  app.post('/api/v1/docs/:id/publish', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = PublishCopySchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    const sourceId = (req.params as { id: string }).id
    const source = db.prepare(
      `SELECT d.id, d.title, d.source_type AS sourceType, d.storage_key AS storageKey,
              d.content_hash AS contentHash, d.byte_size AS byteSize,
              d.owner_id AS ownerId, d.sensitivity, d.volatility, s.kind AS scopeKind
         FROM documents d JOIN v_effective_scopes s ON s.id=d.scope_id
        WHERE d.id=? AND d.status='ready'`
    ).get(sourceId) as {
      id: string; title: string; sourceType: string; storageKey: string; contentHash: string
      byteSize: number; ownerId: string | null; sensitivity: number
      volatility: 'stable' | 'volatile'; scopeKind: string
    } | undefined
    if (!source || source.scopeKind !== 'personal' || source.ownerId !== claims.sub ||
      !canAccessScope(ctx, `personal-${claims.sub}`)) {
      return reply.code(404).send(fail(4041, '个人源文档不存在或无权发布'))
    }
    const target = db.prepare(
      `SELECT id,kind FROM v_effective_scopes WHERE id=?`
    ).get(parsed.data.targetScopeId) as { id: string; kind: string } | undefined
    if (!target || target.kind === 'personal' || !canAccessScope(ctx, target.id)) {
      return reply.code(403).send(fail(4033, '只能发布到当前用户可见的团队/组织空间'))
    }
    const existing = db.prepare(
      `SELECT id,status FROM documents
        WHERE scope_id=? AND content_hash=? AND status!='archived'
        ORDER BY created_at DESC LIMIT 1`
    ).get(target.id, source.contentHash) as { id: string; status: string } | undefined
    if (existing) return reply.send(ok({
      submissionId: null, docId: existing.id, state: 'approved',
      documentStatus: existing.status, dedup: true
    }))
    const bytes = await storage.get(source.storageKey)
    const capabilityError = await sourceCapabilityError(source.sourceType, app.deps, bytes.length)
    if (capabilityError) return reply.code(503).send(fail(5033, capabilityError))
    const report = await scanDocument(bytes, source.sourceType, cfg)
    const ext = source.storageKey.split('.').at(-1) || source.sourceType
    const quarantineKey = await storage.put(bytes, ext, 'quarantine/documents')
    const now = Date.now()
    const submissionId = randomUUID()
    const autoApprove = claims.role !== 'member'
    const tags = parsed.data.tags ?? (db.prepare('SELECT tag FROM doc_tags WHERE doc_id=?').all(sourceId) as { tag: string }[])
      .map((row) => row.tag)
    const submission: SubmissionRow = {
      id: submissionId,
      submitterId: claims.sub,
      targetScope: target.id,
      title: parsed.data.title ?? source.title,
      sourceType: source.sourceType,
      storageKey: quarantineKey,
      contentHash: source.contentHash,
      byteSize: bytes.length,
      sensitivity: parsed.data.sensitivity ?? source.sensitivity,
      volatility: parsed.data.volatility ?? source.volatility,
      tagsJson: JSON.stringify(tags),
      state: report.status === 'passed' ? (autoApprove ? 'approved' : 'pending') : 'rejected',
      scanStatus: report.status,
      scanReportJson: JSON.stringify(report),
      quarantineStorageKey: quarantineKey,
      sourceDocumentId: sourceId
    }
    let docId: string | null = null
    if (report.status === 'passed' && autoApprove) {
      const publishedKey = await storage.move(quarantineKey, 'published/documents')
      submission.storageKey = publishedKey
      submission.publishedStorageKey = publishedKey
      submission.quarantineStorageKey = null
      docId = createDocumentFromSubmission(app, submission, now)
    }
    db.prepare(
      `INSERT INTO document_submissions
         (id,submitter_id,target_scope,title,source_type,storage_key,content_hash,byte_size,
          sensitivity,volatility,tags_json,state,reviewer_id,review_note,result_document_id,
          created_at,reviewed_at,source_document_id,quarantine_storage_key,published_storage_key,
          scan_status,scan_report_json,scan_started_at,scan_completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      submissionId, claims.sub, target.id, submission.title, source.sourceType,
      submission.storageKey, source.contentHash, bytes.length, submission.sensitivity,
      submission.volatility, submission.tagsJson, submission.state,
      autoApprove && report.status === 'passed' ? claims.sub : null,
      report.status === 'failed' ? scanMessage(report) : null, docId, now,
      autoApprove || report.status === 'failed' ? now : null, sourceId,
      submission.quarantineStorageKey ?? null, submission.publishedStorageKey ?? null,
      report.status, JSON.stringify(report), now, now
    )
    app.audit(req, report.status === 'failed' ? 'document_scan_failed' :
      autoApprove ? 'upload' : 'document_submit', submissionId, {
      sourceDocumentId: sourceId, targetScope: target.id, docId
    })
    if (report.status === 'failed') {
      return reply.code(422).send(fail(4221, `文档技术扫描未通过: ${scanMessage(report)}`))
    }
    return reply.send(ok({
      submissionId, docId, state: autoApprove ? 'approved' : 'pending',
      documentStatus: docId ? 'pending' : null, scanStatus: 'passed', dedup: false
    }))
  })

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
      const targetScope = fields.targetScopeId?.value ?? fields.scopeId?.value
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
      if (scope.kind === 'personal' && !policyAllows(db, 'allow_personal_cloud')) {
        return reply.code(403).send(fail(4036, '企业策略已禁用个人云知识'))
      }

      const fileName = data.filename ?? 'untitled'
      const sourceType = sourceTypeFromName(fileName)
      if (!sourceType) {
        return reply
          .code(415)
          .send(fail(4151, `不支持的文件类型，当前支持: ${SUPPORTED_EXTENSIONS.join(' ')}`))
      }
      const capabilityError = await sourceCapabilityError(sourceType, app.deps)
      if (capabilityError) {
        data.file.resume()
        return reply.code(503).send(fail(5033, capabilityError))
      }
      const buf = await data.toBuffer()
      if (data.file.truncated) {
        return reply
          .code(413)
          .send(fail(4131, `文件超过上限 ${Math.floor(cfg.maxUploadBytes / 1048576)}MB`))
      }
      const sizedCapabilityError = await sourceCapabilityError(sourceType, app.deps, buf.length)
      if (sizedCapabilityError) return reply.code(503).send(fail(5033, sizedCapabilityError))

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

      const now = Date.now()
      const id = randomUUID()
      const title = fields.title?.value?.trim() || fileName
      const sensitivity = Math.max(0, Math.min(2, Number(fields.sensitivity?.value ?? 0)))
      const volatility = fields.volatility?.value === 'volatile' ? 'volatile' : 'stable'
      const tags = readTags(fields.tags?.value)
      const autoApprove = scope.kind === 'personal' || claims.role !== 'member'
      const sourceDocumentId = fields.sourceDocumentId?.value?.trim() || null
      if (sourceDocumentId) {
        const source = db.prepare(
          `SELECT d.id FROM documents d
            JOIN v_user_scopes us ON us.scope_id=d.scope_id AND us.user_id=?
           WHERE d.id=? AND d.owner_id=? AND d.status!='archived'`
        ).get(claims.sub, sourceDocumentId, claims.sub)
        if (!source) return reply.code(403).send(fail(4033, '来源文档不存在或不属于当前用户'))
      }

      const ext = fileName.slice(fileName.lastIndexOf('.') + 1)
      const quarantineKey = await storage.put(buf, ext, 'quarantine/documents')

      const submission: SubmissionRow = {
        id,
        submitterId: claims.sub,
        targetScope,
        title,
        sourceType,
        storageKey: quarantineKey,
        contentHash,
        byteSize: buf.length,
        sensitivity,
        volatility,
        tagsJson: JSON.stringify(tags),
        state: 'pending',
        scanStatus: 'scanning',
        quarantineStorageKey: quarantineKey,
        sourceDocumentId
      }

      db.prepare(
        `INSERT INTO document_submissions
           (id, submitter_id, target_scope, title, source_type, storage_key, content_hash,
            byte_size, sensitivity, volatility, tags_json, state, reviewer_id,
            reviewed_at, created_at, source_document_id, quarantine_storage_key,
            scan_status, scan_started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        claims.sub,
        targetScope,
        title,
        sourceType,
        quarantineKey,
        contentHash,
        buf.length,
        sensitivity,
        volatility,
        submission.tagsJson,
        'pending',
        null,
        null,
        now,
        sourceDocumentId,
        quarantineKey,
        'scanning',
        now
      )

      const report = await scanDocument(buf, sourceType, cfg)
      const completedAt = Date.now()
      if (report.status === 'failed') {
        db.prepare(
          `UPDATE document_submissions
              SET state='rejected', scan_status='failed', scan_report_json=?,
                  review_note=?, reviewed_at=?, scan_completed_at=?
            WHERE id=?`
        ).run(JSON.stringify(report), scanMessage(report), completedAt, completedAt, id)
        app.audit(req, 'document_scan_failed', id, {
          targetScope,
          findingCodes: report.findings.map((item) => item.code)
        })
        return reply.code(422).send(fail(4221, `文档技术扫描未通过: ${scanMessage(report)}`))
      }

      db.prepare(
        `UPDATE document_submissions
            SET scan_status='passed', scan_report_json=?, scan_completed_at=?
          WHERE id=?`
      ).run(JSON.stringify(report), completedAt, id)

      let docId: string | null = null
      if (autoApprove) {
        const publishedKey = await storage.move(quarantineKey, 'published/documents')
        submission.storageKey = publishedKey
        submission.state = 'approved'
        submission.publishedStorageKey = publishedKey
        docId = createDocumentFromSubmission(app, submission, now)
        db.prepare(
          `UPDATE document_submissions
              SET state='approved', storage_key=?, quarantine_storage_key=NULL,
                  published_storage_key=?, reviewer_id=?, reviewed_at=?, result_document_id=?
            WHERE id=?`
        ).run(publishedKey, publishedKey, claims.sub, completedAt, docId, id)
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
        state: autoApprove ? 'approved' : 'pending',
        scanStatus: 'passed',
        scanReport: report,
        documentStatus: docId ? 'pending' : null,
        dedup: false
      }))
    }
  )

  app.get('/api/v1/document-submissions/mine', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const rows = db.prepare(
      `SELECT ds.id, ds.title, ds.source_type AS sourceType, ds.byte_size AS byteSize,
              ds.state, ds.scan_status AS scanStatus,
              ds.scan_report_json AS scanReportJson, ds.review_note AS reviewNote,
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
    return reply.send(ok((rows as Record<string, unknown>[]).map((row) => ({
      ...row,
      scanReport: typeof row.scanReportJson === 'string' ? JSON.parse(row.scanReportJson) : null,
      scanReportJson: undefined
    }))))
  })

  app.get('/api/v1/document-submissions/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    const id = (req.params as { id: string }).id
    const row = db.prepare(
      `SELECT ds.id, ds.submitter_id AS submitterId, ds.title,
              ds.source_type AS sourceType, ds.byte_size AS byteSize,
              ds.sensitivity, ds.volatility, ds.tags_json AS tagsJson,
              ds.state, ds.scan_status AS scanStatus,
              ds.scan_report_json AS scanReportJson, ds.review_note AS reviewNote,
              ds.result_document_id AS resultDocumentId,
              ds.created_at AS createdAt, ds.reviewed_at AS reviewedAt,
              ds.target_scope AS targetScope, s.name AS scopeName, s.kind AS scopeKind
         FROM document_submissions ds
         JOIN v_effective_scopes s ON s.id=ds.target_scope
        WHERE ds.id=?`
    ).get(id) as Record<string, unknown> | undefined
    if (!row || (row.submitterId !== claims.sub && claims.role !== 'admin' &&
      !(claims.role === 'curator' && canAccessScope(ctx, String(row.targetScope))))) {
      return reply.code(404).send(fail(4041, '提交不存在或无权查看'))
    }
    return reply.send(ok({
      ...row,
      tags: typeof row.tagsJson === 'string' ? JSON.parse(row.tagsJson) : [],
      scanReport: typeof row.scanReportJson === 'string' ? JSON.parse(row.scanReportJson) : null,
      tagsJson: undefined,
      scanReportJson: undefined
    }))
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
                ds.scan_status AS scanStatus, ds.scan_report_json AS scanReportJson,
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
        scanReport: typeof row.scanReportJson === 'string' ? JSON.parse(row.scanReportJson) : null,
        tagsJson: undefined,
        scanReportJson: undefined
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
                volatility, tags_json AS tagsJson, state,
                scan_status AS scanStatus,
                quarantine_storage_key AS quarantineStorageKey,
                published_storage_key AS publishedStorageKey,
                source_document_id AS sourceDocumentId
           FROM document_submissions WHERE id = ?`
      ).get(id) as SubmissionRow | undefined
      if (!row) return reply.code(404).send(fail(4041, '提交不存在'))
      if (row.state !== 'pending') return reply.code(409).send(fail(4093, `该提交已处理(${row.state})`))
      if (row.scanStatus !== 'passed') {
        return reply.code(409).send(fail(4096, `技术扫描未通过(${row.scanStatus ?? 'unknown'})`))
      }
      if (claims.role !== 'admin' && !canAccessScope(ctx, row.targetScope)) {
        return reply.code(403).send(fail(4034, '无权审核该范围的提交'))
      }

      const existing = db.prepare(
        `SELECT id, status FROM documents
          WHERE scope_id = ? AND content_hash = ? AND status != 'archived'
          ORDER BY created_at DESC LIMIT 1`
      ).get(row.targetScope, row.contentHash) as { id: string; status: string } | undefined
      if (!existing) {
        const capabilityError = await sourceCapabilityError(row.sourceType, app.deps, row.byteSize)
        if (capabilityError) return reply.code(503).send(fail(5033, capabilityError))
      }
      const now = Date.now()
      if (!row.publishedStorageKey) {
        const sourceKey = row.quarantineStorageKey ?? row.storageKey
        row.publishedStorageKey = await storage.move(sourceKey, 'published/documents')
        row.quarantineStorageKey = null
        row.storageKey = row.publishedStorageKey
        db.prepare(
          `UPDATE document_submissions
              SET storage_key=?, published_storage_key=?, quarantine_storage_key=NULL
            WHERE id=?`
        ).run(row.storageKey, row.storageKey, id)
      } else {
        row.storageKey = row.publishedStorageKey
      }
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
