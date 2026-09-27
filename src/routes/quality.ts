import type { FastifyInstance } from 'fastify'
import { ok } from '../reply.js'
import { requireAdmin } from '../auth/jwt.js'

/**
 * 质量看板。
 *
 * 数据来自 qa_events,统计:
 *   - 无答案率 / 负反馈率 / agentic 占比 / 平均延迟 + p50/p95;
 *   - 知识盲区(无答案问题聚类);
 *   - 长期零引用文档;
 *   - 各 status 文档数。
 *
 * 权限:仅管理员可查看跨组织提问与反馈统计。
 */
export function registerQualityRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  app.get(
    '/api/v1/admin/quality/overview',
    { preHandler: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const q = req.query as Record<string, string>
      const days = Math.min(Math.max(Number(q.days ?? 30) || 30, 1), 365)
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

      // p50/p95:SQLite 没有百分位函数,用 LIMIT/OFFSET 取序位;只统计当前
      // 用户集合内的事件,与 totals 一致。
      const percentile = (p: number): number | null => {
        const count = (db.prepare('SELECT COUNT(*) AS n FROM qa_events WHERE created_at >= ? AND latency_ms IS NOT NULL')
          .get(since) as { n: number }).n
        if (count === 0) return null
        const offset = Math.floor((count - 1) * p)
        const row = db
          .prepare(
            `SELECT latency_ms AS v FROM qa_events
              WHERE created_at >= ? AND latency_ms IS NOT NULL
              ORDER BY latency_ms LIMIT 1 OFFSET ?`
          )
          .get(since, offset) as { v: number } | undefined
        return row?.v ?? null
      }

      // 知识盲区:没答上来的问题聚合。
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

      // cited_chunks contains chunk ids, not document ids.
      const unusedDocs = db
        .prepare(
          `SELECT d.id, d.title, d.created_at AS createdAt
             FROM documents d
            WHERE d.status = 'ready'
              AND NOT EXISTS (
                SELECT 1 FROM qa_events e, json_each(e.cited_chunks) cited
                 JOIN chunks c ON c.id = cited.value
                WHERE c.doc_id = d.id
              )
            ORDER BY d.created_at LIMIT 20`
        )
        .all()

      const docStats = db
        .prepare(
          `SELECT status, COUNT(*) AS n
             FROM documents d
            GROUP BY status`
        )
        .all() as { status: string; n: number }[]

      return reply.send(
        ok({
          windowDays: days,
          total,
          unansweredRate: total ? (totals.unanswered ?? 0) / total : 0,
          negativeRate: total ? (totals.negative ?? 0) / total : 0,
          agenticRate: total ? (totals.agentic ?? 0) / total : 0,
          latency: {
            avg: totals.avgLatency == null ? null : Math.round(totals.avgLatency),
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
