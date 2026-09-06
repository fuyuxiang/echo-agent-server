import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { requireCurator, type AuthedRequest } from '../auth/jwt.js'
import { loadAccessContext, canAccessScope } from '../auth/scopes.js'
import { searchMemories } from '../kb/retrieve/recall.js'

const PatchSchema = z.object({
  kind: z.enum(['fact', 'decision', 'convention', 'pitfall', 'howto']).optional(),
  content: z.string().min(1).max(2000).optional(),
  rationale: z.string().max(2000).nullable().optional(),
  evidence: z.array(z.object({
    type: z.enum(['doc', 'qa', 'meeting', 'task']),
    id: z.string().min(1).max(256),
    loc: z.string().max(1000).optional()
  })).max(20).nullable().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  observedAt: z.coerce.number().int().nullable().optional(),
  validFrom: z.coerce.number().int().nullable().optional(),
  validUntil: z.coerce.number().int().nullable().optional(),
  sourceSessionId: z.string().max(256).nullable().optional(),
  sourceTaskId: z.string().max(256).nullable().optional(),
  workspaceRef: z.string().max(1000).nullable().optional(),
  outcome: z.string().max(2000).nullable().optional(),
  sensitivity: z.coerce.number().int().min(0).max(3).optional(),
  trust: z.enum(['reported', 'reviewed', 'verified']).optional(),
  status: z.enum(['active', 'superseded', 'retired']).optional()
})

export function registerMemoryRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  app.get('/api/v1/memories', { preHandler: app.authenticate }, async (req, reply) => {
    const q = req.query as Record<string, string>
    if (q.kind && !['fact', 'decision', 'convention', 'pitfall', 'howto'].includes(q.kind)) {
      return reply.code(400).send(fail(4001, '记忆类型无效'))
    }
    if (q.status && !['active', 'superseded', 'retired'].includes(q.status)) {
      return reply.code(400).send(fail(4001, '记忆状态无效'))
    }
    if ((q.scope?.length ?? 0) > 256 || (q.q?.length ?? 0) > 2000) {
      return reply.code(400).send(fail(4001, '查询参数过长'))
    }
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    if (ctx.scopeIds.length === 0) return reply.send(ok([]))

    const where = [
      `m.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})`,
      'm.sensitivity <= ?'
    ]
    const params: unknown[] = [...ctx.scopeIds, ctx.clearance]
    if (q.kind) { where.push('m.kind = ?'); params.push(q.kind) }
    if (q.scope) { where.push('m.scope_id = ?'); params.push(q.scope) }
    where.push(q.status ? 'm.status = ?' : "m.status = 'active'")
    if (q.status) params.push(q.status)
    if (q.q) { where.push('m.content LIKE ?'); params.push(`%${q.q}%`) }

    const rows = db
      .prepare(
        `SELECT m.id, m.kind, m.content, m.rationale, m.evidence, m.confidence,
                m.hit_count AS hitCount, m.observed_at AS observedAt,
                m.valid_from AS validFrom, m.valid_until AS validUntil,
                m.supersedes_id AS supersedesId, m.source_session_id AS sourceSessionId,
                m.source_task_id AS sourceTaskId, m.workspace_ref AS workspaceRef,
                m.outcome, m.sensitivity, m.trust, m.status,
                m.created_at AS createdAt, m.updated_at AS updatedAt,
                s.kind AS scopeKind, s.name AS scopeName, s.id AS scopeId,
                u.display_name AS authorName
           FROM org_memories m
           JOIN v_effective_scopes s ON s.id = m.scope_id
           LEFT JOIN users u ON u.id = m.author_id
          WHERE ${where.join(' AND ')}
          ORDER BY m.hit_count DESC, m.updated_at DESC
          LIMIT 200`
      )
      .all(...params) as Array<Record<string, unknown> & { evidence?: string | null }>
    return reply.send(ok(rows.map((row) => ({
      ...row,
      evidence: parseEvidence(row.evidence),
      stale: typeof row.validUntil === 'number' && row.validUntil < Date.now()
    }))))
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
        .prepare(
          'SELECT scope_id AS scopeId, valid_from AS validFrom, valid_until AS validUntil FROM org_memories WHERE id = ?'
        )
        .get(id) as { scopeId: string; validFrom: number | null; validUntil: number | null } | undefined
      if (!mem) return reply.code(404).send(fail(4041, '记忆不存在'))
      if (claims.role !== 'admin' && !canAccessScope(ctx, mem.scopeId)) {
        return reply.code(403).send(fail(4035, '无权修改该记忆'))
      }

      const v = parsed.data
      if (v.sensitivity !== undefined && v.sensitivity > ctx.clearance) {
        return reply.code(403).send(fail(4036, '不能设置高于自身密级的组织记忆'))
      }
      const effectiveValidFrom = v.validFrom !== undefined ? v.validFrom : mem.validFrom
      const effectiveValidUntil = v.validUntil !== undefined ? v.validUntil : mem.validUntil
      if (
        effectiveValidFrom !== null
        && effectiveValidUntil !== null
        && effectiveValidFrom > effectiveValidUntil
      ) {
        return reply.code(400).send(fail(4002, 'validFrom 不能晚于 validUntil'))
      }
      const sets: string[] = []
      const params: unknown[] = []
      if (v.kind !== undefined) { sets.push('kind = ?'); params.push(v.kind) }
      if (v.content !== undefined) { sets.push('content = ?'); params.push(v.content) }
      if (v.rationale !== undefined) { sets.push('rationale = ?'); params.push(v.rationale) }
      if (v.evidence !== undefined) {
        sets.push('evidence = ?')
        params.push(v.evidence === null ? null : JSON.stringify(v.evidence))
      }
      if (v.confidence !== undefined) { sets.push('confidence = ?'); params.push(v.confidence) }
      if (v.observedAt !== undefined) { sets.push('observed_at = ?'); params.push(v.observedAt) }
      if (v.validFrom !== undefined) { sets.push('valid_from = ?'); params.push(v.validFrom) }
      if (v.validUntil !== undefined) { sets.push('valid_until = ?'); params.push(v.validUntil) }
      if (v.sourceSessionId !== undefined) { sets.push('source_session_id = ?'); params.push(v.sourceSessionId) }
      if (v.sourceTaskId !== undefined) { sets.push('source_task_id = ?'); params.push(v.sourceTaskId) }
      if (v.workspaceRef !== undefined) { sets.push('workspace_ref = ?'); params.push(v.workspaceRef) }
      if (v.outcome !== undefined) { sets.push('outcome = ?'); params.push(v.outcome) }
      if (v.sensitivity !== undefined) { sets.push('sensitivity = ?'); params.push(v.sensitivity) }
      if (v.trust !== undefined) { sets.push('trust = ?'); params.push(v.trust) }
      if (v.status !== undefined) { sets.push('status = ?'); params.push(v.status) }
      if (sets.length === 0) return reply.send(ok({ updated: false }))

      sets.push('updated_at = ?')
      params.push(Date.now())
      db.prepare(`UPDATE org_memories SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
      app.audit(req, 'memory_patch', id, { fields: Object.keys(v) })
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
      app.audit(req, 'memory_retire', id)
      return reply.send(ok({ retired: true }))
    }
  )

  /**
   * 待裁决的记忆矛盾。
   *
   * 矛盾由 consolidator 或人工写入 memory_conflicts。
   * 这里只读 + 决议接口,创建矛盾留给后台任务与 promotions。
   * 权限:仅 admin 看全部,curator 只能看自己可见 scope 的矛盾对。
   */
  app.get(
    '/api/v1/memories/conflicts',
    { preHandler: [app.authenticate, requireCurator] },
    async (_req, reply) => {
      const claims = (_req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)

      let where = ''
      const params: unknown[] = []
      if (claims.role !== 'admin') {
        if (ctx.scopeIds.length === 0) return reply.send(ok([]))
        // 两侧都可见才允许读取冲突详情；只看见一侧时返回另一侧正文会泄密。
        where =
          `WHERE a.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})` +
          ` AND b.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})`
        params.push(...ctx.scopeIds, ...ctx.scopeIds)
      }

      const rows = db
        .prepare(
          `SELECT c.id, c.reason, c.resolution, c.created_at AS createdAt,
                  a.id AS aId, a.kind AS aKind, a.content AS aContent,
                  a.scope_id AS aScopeId, sa.name AS aScopeName,
                  b.id AS bId, b.kind AS bKind, b.content AS bContent,
                  b.scope_id AS bScopeId, sb.name AS bScopeName
             FROM memory_conflicts c
             JOIN org_memories a ON a.id = c.a_id
             LEFT JOIN scopes sa ON sa.id = a.scope_id
             JOIN org_memories b ON b.id = c.b_id
             LEFT JOIN scopes sb ON sb.id = b.scope_id
             ${where}
            ORDER BY c.created_at DESC
            LIMIT 200`
        )
        .all(...params) as Record<string, unknown>[]

      return reply.send(ok(rows))
    }
  )

  /**
   * 决议记忆矛盾。
   *
   *   POST /api/v1/memories/conflicts/:id/resolve
   *   body: { resolution: 'keep_a'|'keep_b'|'merge'|'both_ok', merged_content?: string }
   *
   * - keep_a: 保留 a,b 退休(retired);
   * - keep_b: 保留 b,a 退休;
   * - merge:  用 merged_content 创建新 active 记忆,a/b 退休;
   * - both_ok: 两条都保留为 active(说明不互斥)。
   */
  app.post(
    '/api/v1/memories/conflicts/:id/resolve',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const parsed = z
        .object({
          resolution: z.enum(['keep_a', 'keep_b', 'merge', 'both_ok']),
          mergedContent: z.string().min(1).max(2000).optional(),
          mergedKind: z
            .enum(['fact', 'decision', 'convention', 'pitfall', 'howto'])
            .optional(),
          mergedScopeId: z.string().optional(),
          note: z.string().max(2000).optional()
        })
        .safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply
          .code(400)
          .send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message ?? '未知'}`))
      }

      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims
      const ctx = loadAccessContext(db, claims.sub)

      const c = db
        .prepare(
          `SELECT a_id AS aId, b_id AS bId, resolution, a.scope_id AS aScopeId
             FROM memory_conflicts c
             JOIN org_memories a ON a.id = c.a_id
            WHERE c.id = ?`
        )
        .get(id) as
        | { aId: string; bId: string; resolution: string | null; aScopeId: string }
        | undefined
      if (!c) return reply.code(404).send(fail(4041, '矛盾不存在'))
      if (c.resolution) return reply.code(409).send(fail(4094, '该矛盾已处理'))

      // curator 必须同时管理 a/b 两侧；决议会退休或合并两条记忆，只有一侧
      // 权限时允许操作会造成跨团队数据破坏。
      const bScope = db
        .prepare('SELECT scope_id AS scopeId FROM org_memories WHERE id = ?')
        .get(c.bId) as { scopeId: string } | undefined
      if (
        claims.role !== 'admin' &&
        (!canAccessScope(ctx, c.aScopeId) ||
          !(bScope && canAccessScope(ctx, bScope.scopeId)))
      ) {
        return reply.code(403).send(fail(4037, '无权处理该矛盾'))
      }

      if (parsed.data.resolution === 'merge' && !parsed.data.mergedContent) {
        return reply.code(400).send(fail(4002, 'merge 必须提供 mergedContent'))
      }

      let resultId: string | null = null
      const now = Date.now()

      db.transaction(() => {
        if (parsed.data.resolution === 'keep_a') {
          db.prepare("UPDATE org_memories SET status='retired', updated_at=? WHERE id=?").run(
            now,
            c.bId
          )
        } else if (parsed.data.resolution === 'keep_b') {
          db.prepare("UPDATE org_memories SET status='retired', updated_at=? WHERE id=?").run(
            now,
            c.aId
          )
        } else if (parsed.data.resolution === 'both_ok') {
          // 保持 active,仅记录决议
        } else {
          // merge:新建 active 记忆
          const newId = randomUUID()
          db.prepare(
            `INSERT INTO org_memories
               (id, scope_id, kind, content, rationale, evidence, author_id,
                confidence, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,0.9,'active',?,?)`
          ).run(
            newId,
            parsed.data.mergedScopeId ?? c.aScopeId,
            parsed.data.mergedKind ?? 'fact',
            parsed.data.mergedContent!,
            `合并自 ${c.aId} 与 ${c.bId}${parsed.data.note ? `: ${parsed.data.note}` : ''}`,
            JSON.stringify([
              { type: 'memory', id: c.aId },
              { type: 'memory', id: c.bId }
            ]),
            claims.sub,
            now,
            now
          )
          db.prepare("UPDATE org_memories SET status='retired', updated_at=? WHERE id IN (?,?)").run(
            now,
            c.aId,
            c.bId
          )
          resultId = newId
        }

        db.prepare(
          `UPDATE memory_conflicts
              SET resolution=?, created_at=?
            WHERE id=?`
        ).run(parsed.data.resolution, now, id)
      })()

      app.audit(req, 'conflict_resolve', id, {
        resolution: parsed.data.resolution,
        resultId
      })
      return reply.send(ok({ resolution: parsed.data.resolution, resultId }))
    }
  )
}

function parseEvidence(value: string | null | undefined): unknown[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
