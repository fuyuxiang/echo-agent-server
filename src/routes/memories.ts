import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { requireCurator, type AuthedRequest } from '../auth/jwt.js'
import { loadAccessContext, canAccessScope } from '../auth/scopes.js'
import { searchMemories } from '../kb/retrieve/recall.js'

const PatchSchema = z.object({
  content: z.string().min(1).max(2000).optional(),
  rationale: z.string().max(2000).nullable().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  validUntil: z.coerce.number().int().nullable().optional(),
  status: z.enum(['active', 'superseded', 'retired']).optional()
})

export function registerMemoryRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  app.get('/api/v1/memories', { preHandler: app.authenticate }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    if (ctx.scopeIds.length === 0) return reply.send(ok([]))

    const where = [`m.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})`]
    const params: unknown[] = [...ctx.scopeIds]
    if (q.kind) { where.push('m.kind = ?'); params.push(q.kind) }
    if (q.scope) { where.push('m.scope_id = ?'); params.push(q.scope) }
    where.push(q.status ? 'm.status = ?' : "m.status = 'active'")
    if (q.status) params.push(q.status)
    if (q.q) { where.push('m.content LIKE ?'); params.push(`%${q.q}%`) }

    const rows = db
      .prepare(
        `SELECT m.id, m.kind, m.content, m.rationale, m.evidence, m.confidence,
                m.hit_count AS hitCount, m.valid_until AS validUntil, m.status,
                m.created_at AS createdAt, m.updated_at AS updatedAt,
                s.kind AS scopeKind, s.name AS scopeName, s.id AS scopeId,
                u.display_name AS authorName
           FROM org_memories m
           JOIN scopes s ON s.id = m.scope_id
           LEFT JOIN users u ON u.id = m.author_id
          WHERE ${where.join(' AND ')}
          ORDER BY m.hit_count DESC, m.updated_at DESC
          LIMIT 200`
      )
      .all(...params)
    return reply.send(ok(rows))
  })

  app.post('/api/v1/memories/search', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = z
      .object({ query: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).default(10) })
      .safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))

    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    return reply.send(ok(searchMemories(db, parsed.data.query, ctx, parsed.data.limit)))
  })

  app.patch(
    '/api/v1/memories/:id',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const parsed = PatchSchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)

      const mem = db
        .prepare('SELECT scope_id AS scopeId FROM org_memories WHERE id = ?')
        .get(id) as { scopeId: string } | undefined
      if (!mem) return reply.code(404).send(fail(4041, '记忆不存在'))
      if (claims.role !== 'admin' && !canAccessScope(ctx, mem.scopeId)) {
        return reply.code(403).send(fail(4035, '无权修改该记忆'))
      }

      const v = parsed.data
      const sets: string[] = []
      const params: unknown[] = []
      if (v.content !== undefined) { sets.push('content = ?'); params.push(v.content) }
      if (v.rationale !== undefined) { sets.push('rationale = ?'); params.push(v.rationale) }
      if (v.confidence !== undefined) { sets.push('confidence = ?'); params.push(v.confidence) }
      if (v.validUntil !== undefined) { sets.push('valid_until = ?'); params.push(v.validUntil) }
      if (v.status !== undefined) { sets.push('status = ?'); params.push(v.status) }
      if (sets.length === 0) return reply.send(ok({ updated: false }))

      sets.push('updated_at = ?')
      params.push(Date.now())
      db.prepare(`UPDATE org_memories SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
      return reply.send(ok({ updated: true }))
    }
  )

  /** 退休而非物理删除:记忆可能已被引用,保留记录让答案可追溯。 */
  app.delete(
    '/api/v1/memories/:id',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)

      const mem = db
        .prepare('SELECT scope_id AS scopeId FROM org_memories WHERE id = ?')
        .get(id) as { scopeId: string } | undefined
      if (!mem) return reply.code(404).send(fail(4041, '记忆不存在'))
      if (claims.role !== 'admin' && !canAccessScope(ctx, mem.scopeId)) {
        return reply.code(403).send(fail(4035, '无权删除该记忆'))
      }

      db.prepare("UPDATE org_memories SET status='retired', updated_at=? WHERE id=?").run(
        Date.now(),
        id
      )
      return reply.send(ok({ retired: true }))
    }
  )
}
