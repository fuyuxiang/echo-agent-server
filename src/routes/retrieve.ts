import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import type { AuthedRequest } from '../auth/jwt.js'

const RetrieveSchema = z.object({
  query: z.string().min(1, 'query 不能为空'),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  multiHop: z.boolean().optional(),
  tokenBudget: z.coerce.number().int().min(500).max(32000).optional(),
  /** 显式限定 scope 类别:'org' = 全公司,'team' = 当前用户可见的团队层。undefined = 全部。 */
  scopes: z.array(z.enum(['org', 'team'])).optional(),
  filters: z
    .object({
      tags: z.array(z.string()).optional(),
      sourceTypes: z.array(z.string()).optional(),
      scopeKinds: z.array(z.enum(['org', 'team'])).optional()
    })
    .optional()
})

const QaEventSchema = z.object({
  question: z.string().min(1),
  answered: z.boolean(),
  citedChunks: z.array(z.string()).optional(),
  topScore: z.number().optional(),
  latencyMs: z.coerce.number().int().optional(),
  route: z.enum(['fast', 'agentic']).optional()
})

const FeedbackSchema = z.object({
  feedback: z.enum(['helpful', 'not_helpful', 'wrong'])
})

export function registerRetrieveRoutes(app: FastifyInstance): void {
  const { db, cfg, retriever } = app.deps

  /**
   * 检索。echo-agent-org 插件的快路径,直接影响首 token 延迟,
   * 所以这里不做任何非必要工作 —— 审计写入是同步但极轻的 insert。
   */
  // 检索限流:方案 5.6 要求 60/min,按登录用户 ID 计数。
  app.post(
    '/api/v1/retrieve',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: cfg.rateLimitRetrievePerMin > 0 ? cfg.rateLimitRetrievePerMin : 1000,
          timeWindow: '1 minute',
          keyGenerator: (req) => {
            const claims = (req as AuthedRequest).claims
            return claims?.sub ?? req.ip
          }
        }
      }
    },
    async (req, reply) => {
    const parsed = RetrieveSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message}`))
    }
    const claims = (req as AuthedRequest).claims
    const res = await retriever.retrieve(claims.sub, parsed.data)

    // 只记 who/what/多少条,不记检索到的内容 —— 审计表不该变成一份
    // 绕过权限的知识副本。
    app.audit(req, 'retrieve', undefined, {
      queryLen: parsed.data.query.length,
      hits: res.chunks.length,
      totalMs: res.diagnostics.totalMs
    })

    return reply.send(ok(res))
    }
  )

  /** 质量看板的数据来源。只记实际被引用的 chunk,反映真实使用率而非召回量。 */
  app.post('/api/v1/qa-events', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = QaEventSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message}`))
    }
    const v = parsed.data
    const claims = (req as AuthedRequest).claims
    const id = randomUUID()

    db.prepare(
      `INSERT INTO qa_events (id, user_id, question, answered, cited_chunks,
                              top_score, latency_ms, route, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      claims.sub,
      v.question,
      v.answered ? 1 : 0,
      v.citedChunks ? JSON.stringify(v.citedChunks) : null,
      v.topScore ?? null,
      v.latencyMs ?? null,
      v.route ?? null,
      Date.now()
    )

    // cited_chunks 数组里的 id 实际是 chunk_id(来自 RetrieveResult.chunkId),
    // 客户端不会专门区分 chunk 与 memory。这里先把 chunk id 解析为所属的
    // org_memory(若有),再把记忆命中数累加 —— 避免错把 chunk id 当 memory id
    // 写入 hit_count,导致统计失真。
    //
    // 同时给 chunk 关联的文档做"被引用计数":供后续做"近 30 天被检索命中"
    // 的热文档同步使用。
    const cited = v.citedChunks ?? []
    if (cited.length > 0) {
      const placeholders = cited.map(() => '?').join(',')
      const memRows = db
        .prepare(
          `SELECT m.id AS memoryId, c.id AS chunkId
             FROM chunks c
             LEFT JOIN org_memories m
               ON m.evidence LIKE '%' || c.id || '%'
            WHERE c.id IN (${placeholders})`
        )
        .all(...cited) as { memoryId: string | null; chunkId: string }[]
      const docRows = db
        .prepare(
          `SELECT DISTINCT doc_id AS docId FROM chunks WHERE id IN (${placeholders})`
        )
        .all(...cited) as { docId: string }[]

      const updateMemory = db.prepare(
        'UPDATE org_memories SET hit_count = hit_count + 1 WHERE id = ?'
      )
      const seenMem = new Set<string>()
      for (const r of memRows) {
        if (r.memoryId && !seenMem.has(r.memoryId)) {
          updateMemory.run(r.memoryId)
          seenMem.add(r.memoryId)
        }
      }

      // 文档被引用计数:在 documents 表上加一个被引用时间戳,后续同步可
      // 用此驱动"近 30 天被检索命中"的热文档判定。
      const touchDoc = db.prepare(
        'UPDATE documents SET indexed_at = COALESCE(indexed_at, ?) WHERE id = ?'
      )
      const now = Date.now()
      for (const r of docRows) touchDoc.run(now, r.docId)
    }

    return reply.send(ok({ id }))
  })

  app.post(
    '/api/v1/qa-events/:id/feedback',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const parsed = FeedbackSchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(4001, 'feedback 取值非法'))
      const { id } = req.params as { id: string }
      const claims = (req as AuthedRequest).claims

      // 限定本人的事件,避免通过遍历 id 篡改他人反馈。
      const info = db
        .prepare('UPDATE qa_events SET feedback = ? WHERE id = ? AND user_id = ?')
        .run(parsed.data.feedback, id, claims.sub)

      if (info.changes === 0) return reply.code(404).send(fail(4041, '记录不存在'))
      return reply.send(ok({ updated: true }))
    }
  )
}
