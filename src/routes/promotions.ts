import { randomUUID, createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { requireCurator, type AuthedRequest } from '../auth/jwt.js'
import { loadAccessContext, canAccessScope } from '../auth/scopes.js'
import { enqueueIngest } from '../kb/ingest/worker.js'

/**
 * 知识提升。
 *
 * 这是"知识双向流动"的落点:员工日常工作(会议、问答、任务)产出候选知识,
 * 经审核后进入组织库。三条设计约束:
 *
 *   1. 提升永远是显式的 —— 系统绝不自动把个人内容上传;
 *   2. 审核人可在通过前直接修订 —— 否则提交人反复返工,没人愿意再提;
 *   3. 提交本身不写知识库 —— payload 存在 promotions 里,通过时才落库。
 */

const MemoryPayload = z.object({
  kind: z.enum(['fact', 'decision', 'convention', 'pitfall', 'howto']),
  content: z.string().min(1).max(2000),
  rationale: z.string().max(2000).optional(),
  evidence: z
    .array(
      z.object({
        type: z.enum(['doc', 'qa', 'meeting', 'task']),
        id: z.string(),
        loc: z.string().optional()
      })
    )
    .optional(),
  validUntil: z.coerce.number().int().optional()
})

const DocumentPayload = z.object({
  title: z.string().min(1).max(500),
  // 会议纪要、问答结论这类文本直接内联,不走文件上传。
  text: z.string().min(1),
  sourceType: z.enum(['meeting', 'qa', 'md', 'txt']).default('meeting'),
  volatility: z.enum(['stable', 'volatile']).optional()
})

const CreateSchema = z.object({
  payloadType: z.enum(['document', 'memory']),
  payload: z.unknown(),
  source: z.enum(['meeting', 'qa', 'task', 'manual']),
  targetScope: z.string().min(1)
})

const ReviewSchema = z.object({
  note: z.string().max(2000).optional(),
  /** 审核人的修订。通过时以此覆盖原 payload。 */
  edits: z.unknown().optional()
})

export function registerPromotionRoutes(app: FastifyInstance): void {
  const { db, storage } = app.deps

  app.post('/api/v1/promotions', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message}`))
    }
    const { payloadType, payload, source, targetScope } = parsed.data
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)

    // 只能往自己看得见的范围提 —— 否则可以往任意部门投递内容。
    if (!canAccessScope(ctx, targetScope)) {
      return reply.code(403).send(fail(4033, '无权向该范围提交知识'))
    }

    const shape = payloadType === 'memory' ? MemoryPayload : DocumentPayload
    const body = shape.safeParse(payload)
    if (!body.success) {
      return reply.code(400).send(fail(4002, `内容格式错误: ${body.error.issues[0]?.message}`))
    }

    const id = randomUUID()
    db.prepare(
      `INSERT INTO promotions (id, submitter_id, target_scope, payload_type, payload,
                               source, state, created_at)
       VALUES (?,?,?,?,?,?,'pending',?)`
    ).run(
      id,
      claims.sub,
      targetScope,
      payloadType,
      JSON.stringify(body.data),
      source,
      Date.now()
    )

    app.audit(req, 'promotion_create', id, {
      payloadType,
      source,
      targetScope
    })
    return reply.send(ok({ promotionId: id, state: 'pending' }))
  })

  /** 我提交的。员工需要看到自己那条到底通过了没有。 */
  app.get('/api/v1/promotions/mine', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const rows = db
      .prepare(
        `SELECT p.id, p.payload_type AS payloadType, p.payload, p.source, p.state,
                p.review_note AS reviewNote, p.result_id AS resultId,
                p.created_at AS createdAt, p.reviewed_at AS reviewedAt,
                s.name AS scopeName, s.kind AS scopeKind,
                r.display_name AS reviewerName
           FROM promotions p
           JOIN scopes s ON s.id = p.target_scope
           LEFT JOIN users r ON r.id = p.reviewer_id
          WHERE p.submitter_id = ?
          ORDER BY p.created_at DESC
          LIMIT 100`
      )
      .all(claims.sub) as Record<string, unknown>[]
    return reply.send(ok(rows.map(hydrate)))
  })

  /** 审核队列。curator 只看自己可见范围的,admin 看全部。 */
  app.get(
    '/api/v1/promotions',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const q = req.query as Record<string, string>
      const state = q.state ?? 'pending'
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)

      const where = ['p.state = ?']
      const params: unknown[] = [state]
      if (claims.role !== 'admin') {
        if (ctx.scopeIds.length === 0) return reply.send(ok([]))
        where.push(`p.target_scope IN (${ctx.scopeIds.map(() => '?').join(',')})`)
        params.push(...ctx.scopeIds)
      }
      if (q.scope) {
        where.push('p.target_scope = ?')
        params.push(q.scope)
      }

      const rows = db
        .prepare(
          `SELECT p.id, p.payload_type AS payloadType, p.payload, p.source, p.state,
                  p.created_at AS createdAt, p.target_scope AS targetScope,
                  s.name AS scopeName, s.kind AS scopeKind,
                  u.display_name AS submitterName, u.id AS submitterId
             FROM promotions p
             JOIN scopes s ON s.id = p.target_scope
             JOIN users u ON u.id = p.submitter_id
            WHERE ${where.join(' AND ')}
            ORDER BY p.created_at
            LIMIT 200`
        )
        .all(...params) as Record<string, unknown>[]
      return reply.send(ok(rows.map(hydrate)))
    }
  )

  app.post(
    '/api/v1/promotions/:id/approve',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const parsed = ReviewSchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)

      const promo = db
        .prepare(
          `SELECT id, submitter_id AS submitterId, target_scope AS targetScope,
                  payload_type AS payloadType, payload, source, state
             FROM promotions WHERE id = ?`
        )
        .get(id) as
        | {
            id: string
            submitterId: string
            targetScope: string
            payloadType: 'document' | 'memory'
            payload: string
            source: string
            state: string
          }
        | undefined

      if (!promo) return reply.code(404).send(fail(4041, '记录不存在'))
      if (promo.state !== 'pending') {
        return reply.code(409).send(fail(4093, `该记录已处理(${promo.state})`))
      }
      if (claims.role !== 'admin' && !canAccessScope(ctx, promo.targetScope)) {
        return reply.code(403).send(fail(4034, '无权审核该范围的提交'))
      }

      // 审核人的修订优先。这一步让"通过前顺手改一句"成为可能,是组织层
      // 质量的关键闸门 —— 否则要么放低标准,要么让提交人反复返工。
      const shape = promo.payloadType === 'memory' ? MemoryPayload : DocumentPayload
      const merged = parsed.data.edits
        ? shape.safeParse({ ...JSON.parse(promo.payload), ...(parsed.data.edits as object) })
        : shape.safeParse(JSON.parse(promo.payload))
      if (!merged.success) {
        return reply.code(400).send(fail(4002, `修订后内容非法: ${merged.error.issues[0]?.message}`))
      }

      let resultId: string
      if (promo.payloadType === 'memory') {
        const v = merged.data as z.infer<typeof MemoryPayload>
        resultId = randomUUID()
        const now = Date.now()
        db.prepare(
          `INSERT INTO org_memories (id, scope_id, kind, content, rationale, evidence,
                                     author_id, confidence, status, valid_until,
                                     created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,0.9,'active',?,?,?)`
        ).run(
          resultId,
          promo.targetScope,
          v.kind,
          v.content,
          v.rationale ?? null,
          v.evidence ? JSON.stringify(v.evidence) : null,
          promo.submitterId,
          v.validUntil ?? null,
          now,
          now
        )
      } else {
        const v = merged.data as z.infer<typeof DocumentPayload>
        const buf = Buffer.from(v.text, 'utf8')
        const hash = createHash('sha256').update(buf).digest('hex')
        const storageKey = await storage.put(buf, 'md')
        resultId = randomUUID()
        const now = Date.now()
        db.prepare(
          `INSERT INTO documents (id, scope_id, title, source_type, storage_key, content_hash,
                                  byte_size, owner_id, sensitivity, volatility, status,
                                  created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,0,?,'pending',?,?)`
        ).run(
          resultId,
          promo.targetScope,
          v.title,
          v.sourceType,
          storageKey,
          hash,
          buf.length,
          promo.submitterId,
          v.volatility ?? 'stable',
          now,
          now
        )
        enqueueIngest(db, resultId)
      }

      db.prepare(
        `UPDATE promotions SET state='approved', reviewer_id=?, review_note=?,
                               result_id=?, reviewed_at=? WHERE id=?`
      ).run(claims.sub, parsed.data.note ?? null, resultId, Date.now(), id)

      app.audit(req, 'approve', id, { payloadType: promo.payloadType, resultId })
      return reply.send(ok({ state: 'approved', resultId }))
    }
  )

  app.post(
    '/api/v1/promotions/:id/reject',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const parsed = z
        .object({ note: z.string().min(1, '请说明驳回原因').max(2000) })
        .safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send(fail(4001, parsed.error.issues[0]?.message ?? '参数错误'))
      }
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)

      const promo = db
        .prepare('SELECT target_scope AS targetScope, state FROM promotions WHERE id = ?')
        .get(id) as { targetScope: string; state: string } | undefined
      if (!promo) return reply.code(404).send(fail(4041, '记录不存在'))
      if (promo.state !== 'pending') {
        return reply.code(409).send(fail(4093, `该记录已处理(${promo.state})`))
      }
      if (claims.role !== 'admin' && !canAccessScope(ctx, promo.targetScope)) {
        return reply.code(403).send(fail(4034, '无权审核该范围的提交'))
      }

      db.prepare(
        `UPDATE promotions SET state='rejected', reviewer_id=?, review_note=?, reviewed_at=?
          WHERE id=?`
      ).run(claims.sub, parsed.data.note, Date.now(), id)

      app.audit(req, 'reject', id)
      return reply.send(ok({ state: 'rejected' }))
    }
  )

  /** 撤回。提交人自己反悔,不需要审核人介入。 */
  app.post(
    '/api/v1/promotions/:id/withdraw',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const info = db
        .prepare(
          "UPDATE promotions SET state='withdrawn', reviewed_at=? WHERE id=? AND submitter_id=? AND state='pending'"
        )
        .run(Date.now(), id, claims.sub)
      if (info.changes === 0) {
        return reply.code(404).send(fail(4041, '记录不存在或已处理'))
      }
      app.audit(req, 'promotion_withdraw', id)
      return reply.send(ok({ state: 'withdrawn' }))
    }
  )
}

/** payload 是 JSON 字符串,列表接口直接给前端解析好的对象。 */
function hydrate(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.payload === 'string') {
    try {
      return { ...row, payload: JSON.parse(row.payload) }
    } catch {
      return row
    }
  }
  return row
}
