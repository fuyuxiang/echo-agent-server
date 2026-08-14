import type { FastifyInstance } from 'fastify'
import { ok } from '../reply.js'
import { requireCurator } from '../auth/jwt.js'

/**
 * 质量看板。
 *
 * 数据来自 qa_events 里"实际被引用"的 chunk,不是召回量 —— 召回十条只用
 * 一条,统计召回会高估系统表现。
 *
 * 无答案率突然升高通常意味着摄取出了问题或出现了新的知识盲区,是最值得
 * 盯的单一指标。
 */
export function registerQualityRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  app.get(
    '/api/v1/admin/quality/overview',
    { preHandler: [app.authenticate, requireCurator] },
    async (req, reply) => {
      const q = req.query as Record<string, string>
      const days = Math.min(Number(q.days ?? 30) || 30, 365)
      const since = Date.now() - days * 24 * 3600_000

      const totals = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN answered = 0 THEN 1 ELSE 0 END) AS unanswered,
                  SUM(CASE WHEN feedback = 'helpful' THEN 1 ELSE 0 END) AS helpful,
                  SUM(CASE WHEN feedback IN ('not_helpful','wrong') THEN 1 ELSE 0 END) AS negative,
                  SUM(CASE WHEN route = 'agentic' THEN 1 ELSE 0 END) AS agentic,
                  AVG(latency_ms) AS avgLatency
             FROM qa_events WHERE created_at >= ?`
        )
        .get(since) as Record<string, number | null>

      const total = totals.total ?? 0

      // p50/p95:SQLite 没有百分位函数,用 LIMIT/OFFSET 取序位。
      const percentile = (p: number): number | null => {
        if (total === 0) return null
        const offset = Math.floor((total - 1) * p)
        const row = db
          .prepare(
            `SELECT latency_ms AS v FROM qa_events
              WHERE created_at >= ? AND latency_ms IS NOT NULL
              ORDER BY latency_ms LIMIT 1 OFFSET ?`
          )
          .get(since, offset) as { v: number } | undefined
        return row?.v ?? null
      }

      // 知识盲区:没答上来的问题。直接可以变成"待补充文档"的清单。
      const blindSpots = db
        .prepare(
          `SELECT question, COUNT(*) AS n
             FROM qa_events
            WHERE created_at >= ? AND answered = 0
            GROUP BY question
            ORDER BY n DESC LIMIT 20`
        )
        .all(since)

      const negativeTop = db
        .prepare(
          `SELECT question, feedback, created_at AS createdAt
             FROM qa_events
            WHERE created_at >= ? AND feedback IN ('not_helpful','wrong')
            ORDER BY created_at DESC LIMIT 20`
        )
        .all(since)

      // 长期零引用的文档:候选归档对象,也是"上传了但没人需要"的信号。
      const unusedDocs = db
        .prepare(
          `SELECT d.id, d.title, d.created_at AS createdAt
             FROM documents d
            WHERE d.status = 'ready'
              AND NOT EXISTS (
                SELECT 1 FROM qa_events e
                 WHERE e.cited_chunks IS NOT NULL
                   AND e.cited_chunks LIKE '%' || d.id || '%'
              )
            ORDER BY d.created_at LIMIT 20`
        )
        .all()

      const docStats = db
        .prepare(
          `SELECT status, COUNT(*) AS n FROM documents GROUP BY status`
        )
        .all() as { status: string; n: number }[]

      return reply.send(
        ok({
          windowDays: days,
          total,
          unansweredRate: total ? (totals.unanswered ?? 0) / total : 0,
          negativeRate: total ? (totals.negative ?? 0) / total : 0,
          // 超过 25% 说明客户端的 router 判定过松,token 在浪费。
          agenticRate: total ? (totals.agentic ?? 0) / total : 0,
          latency: {
            avg: totals.avgLatency ? Math.round(totals.avgLatency) : null,
            p50: percentile(0.5),
            p95: percentile(0.95)
          },
          blindSpots,
          negativeTop,
          unusedDocs,
          docStats
        })
      )
    }
  )
}
