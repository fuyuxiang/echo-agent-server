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
            WHERE d.status = 'ready' AND d.id=(SELECT current_document_id FROM document_families WHERE id=d.family_id)
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

      const contributions=db.prepare(`WITH doc_counts AS (
        SELECT d.owner_id AS userId,COUNT(*) AS documents FROM documents d JOIN document_families f ON f.current_document_id=d.id JOIN v_effective_scopes s ON s.id=d.scope_id WHERE d.status='ready' AND f.state='active' AND s.kind!='personal' GROUP BY d.owner_id
      ), memory_counts AS (
        SELECT m.author_id AS userId,COUNT(*) AS memories FROM org_memories m JOIN v_effective_scopes s ON s.id=m.scope_id WHERE m.status='active' AND s.kind!='personal' GROUP BY m.author_id
      ), skill_counts AS (
        SELECT f.owner_id AS userId,COUNT(*) AS skills FROM skill_families f JOIN v_effective_scopes s ON s.id=f.scope_id WHERE f.state='active' AND f.current_version_id IS NOT NULL AND s.kind!='personal' GROUP BY f.owner_id
      ), reuse AS (
        SELECT f.owner_id AS userId,COUNT(DISTINCT q.id||':'||f.id) AS citations FROM qa_events q,json_each(q.cited_chunks) cited JOIN chunks c ON c.id=cited.value JOIN documents d ON d.id=c.doc_id JOIN document_families f ON f.id=d.family_id JOIN v_effective_scopes s ON s.id=f.scope_id WHERE q.created_at>=? AND s.kind!='personal' GROUP BY f.owner_id
      ) SELECT u.id,u.display_name AS displayName,COALESCE(d.documents,0) AS documents,COALESCE(m.memories,0) AS memories,COALESCE(s.skills,0) AS skills,COALESCE(r.citations,0) AS citations FROM users u LEFT JOIN doc_counts d ON d.userId=u.id LEFT JOIN memory_counts m ON m.userId=u.id LEFT JOIN skill_counts s ON s.userId=u.id LEFT JOIN reuse r ON r.userId=u.id WHERE COALESCE(d.documents,0)+COALESCE(m.memories,0)+COALESCE(s.skills,0)+COALESCE(r.citations,0)>0 ORDER BY citations DESC,documents+memories+skills DESC LIMIT 100`).all(since)
      return reply.send(
        ok({
          contributions,
          windowDays: days,
          total,
          unansweredRate: total ? (totals.unanswered ?? 0) / total : 0,
          feedbackCount:(totals.helpful??0)+(totals.negative??0),
          feedbackCoverage:total?((totals.helpful??0)+(totals.negative??0))/total:0,
          negativeRate: ((totals.helpful??0)+(totals.negative??0)) ? (totals.negative??0)/((totals.helpful??0)+(totals.negative??0)) : 0,
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
