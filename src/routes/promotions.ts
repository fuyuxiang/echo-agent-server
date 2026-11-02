import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { requireCurator, type AuthedRequest } from '../auth/jwt.js'
import { loadAccessContext, loadManagementContext, canAccessScope } from '../auth/scopes.js'
import { MemoryPayload, DocumentPayload } from '../operations/publication-payloads.js'
import { processPublication } from '../operations/automatic-publication.js'

/** Members explicitly share knowledge; technical safety checks publish it automatically.
 * Existing submission/history endpoints retain their wire states for desktop compatibility.
 */

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
  const { db, storage, cfg } = app.deps

  app.post('/api/v1/promotions', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message}`))
    }
    const { payloadType, payload, source, targetScope } = parsed.data
    const claims = (req as AuthedRequest).claims
    const ctx = loadManagementContext(db, claims.sub, claims.role)

    // 只能往自己看得见的范围提 —— 否则可以往任意部门投递内容。
    if (!canAccessScope(ctx, targetScope)) {
      return reply.code(403).send(fail(4033, '无权向该范围提交知识'))
    }

    const shape = payloadType === 'memory' ? MemoryPayload : DocumentPayload
    const body = shape.safeParse(payload)
    if (!body.success) {
      return reply.code(400).send(fail(4002, `内容格式错误: ${body.error.issues[0]?.message}`))
    }
    if (payloadType === 'memory') {
      const memory = body.data as z.infer<typeof MemoryPayload>
      if (memory.sensitivity > ctx.clearance) {
        return reply.code(403).send(fail(4034, '不能提交高于自身密级的组织记忆'))
      }
      if (memory.validFrom && memory.validUntil && memory.validFrom > memory.validUntil) {
        return reply.code(400).send(fail(4003, 'validFrom 不能晚于 validUntil'))
      }
      if (memory.supersedesId) {
        const prior = db.prepare(
          'SELECT scope_id AS scopeId,author_id AS authorId FROM org_memories WHERE id=?'
        ).get(memory.supersedesId) as { scopeId: string; authorId: string } | undefined
        if (!prior || prior.scopeId !== targetScope || !canAccessScope(ctx, prior.scopeId) || (claims.role === 'member' && prior.authorId !== claims.sub)) {
          return reply.code(400).send(fail(4004, '被替代记忆不存在或不在目标范围'))
        }
      }
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
    const result = await processPublication(app, 'promotion', id)
    return reply.code(result.scanStatus === 'failed' ? 422 : 200).send(result.scanStatus === 'failed' ? fail(4221, result.message ?? '安全检查未通过') : ok({ promotionId: id, ...result }))
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
           JOIN v_effective_scopes s ON s.id = p.target_scope
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
      const ctx = loadManagementContext(db, claims.sub, claims.role)

      const where = ['p.state = ?',"COALESCE(json_extract(p.payload,'$.sensitivity'),0)<=?"]
      const params: unknown[] = [state,ctx.clearance]
      {
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
             JOIN v_effective_scopes s ON s.id = p.target_scope
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
      const ctx = loadManagementContext(db, claims.sub, claims.role)

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
      if (!canAccessScope(ctx, promo.targetScope)) {
        return reply.code(403).send(fail(4034, '无权审核该范围的提交'))
      }

      if (parsed.data.edits) return reply.code(400).send(fail(4001, '已改为自动安全检查；发布后的内容请在知识维护中修改'))
      if (promo.state === 'approved') return reply.send(ok({ state: 'approved', resultId: (db.prepare('SELECT result_id AS id FROM promotions WHERE id=?').get(id) as any).id }))
      if (promo.state !== 'pending') return reply.code(409).send(fail(4093, `该记录已处理(${promo.state})`))
      const result = await processPublication(app, 'promotion', id)
      return reply.send(ok(result))
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
      const ctx = loadManagementContext(db, claims.sub, claims.role)

      const promo = db
        .prepare('SELECT target_scope AS targetScope, state FROM promotions WHERE id = ?')
        .get(id) as { targetScope: string; state: string } | undefined
      if (!promo) return reply.code(404).send(fail(4041, '记录不存在'))
      if (promo.state !== 'pending') {
        return reply.code(409).send(fail(4093, `该记录已处理(${promo.state})`))
      }
      if (!canAccessScope(ctx, promo.targetScope)) {
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
