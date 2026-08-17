import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '../reply.js'
import { requireAdmin, type AuthedRequest } from '../auth/jwt.js'
import { loadAccessContext } from '../auth/scopes.js'

/**
 * 质量看板。
 *
 * 数据来自 qa_events,统计:
 *   - 无答案率 / 负反馈率 / agentic 占比 / 平均延迟 + p50/p95;
 *   - 知识盲区(无答案问题聚类);
 *   - 长期零引用文档;
 *   - 各 status 文档数。
 *
 * 权限:
 *   - admin 看全部;
 *   - curator 仅看自己可见 scope 的统计,避免越权窥探其他部门问题/盲区。
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

      // 非 admin 走 scope 过滤:仅纳入自己可见 scope 下的 qa_events。
      const claims = (req as AuthedRequest).claims
      let scopedWhere = ''
      const scopedParams: unknown[] = []
      if (claims.role !== 'admin') {
        const ctx = loadAccessContext(db, claims.sub)
        if (ctx.scopeIds.length === 0) {
          return reply.send(
            ok({
              windowDays: days,
              total: 0,
              unansweredRate: 0,
              negativeRate: 0,
              agenticRate: 0,
              latency: { avg: null, p50: null, p95: null },
              blindSpots: [],
              negativeTop: [],
              unusedDocs: [],
              docStats: []
            })
          )
        }
        scopedWhere = ` AND user_id IN (
          SELECT u.id FROM users u
           JOIN user_groups ug ON ug.user_id = u.id
           JOIN scopes s ON s.group_id = ug.group_id
          WHERE s.id IN (${ctx.scopeIds.map(() => '?').join(',')})
        )`
        // 这里没有用 scopeIds,因为 qa_events 是按发起用户过滤(谁提问),不是按 scope
        // 关联 documents。但 user→group→scope 链上,限定"提问者所属 scope"
        // 即可代表 curator 看自己团队/组织能看到的统计。
        scopedParams.push(...ctx.scopeIds)
      }

      const totals = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN answered = 0 THEN 1 ELSE 0 END) AS unanswered,
                  SUM(CASE WHEN feedback = 'helpful' THEN 1 ELSE 0 END) AS helpful,
                  SUM(CASE WHEN feedback IN ('not_helpful','wrong') THEN 1 ELSE 0 END) AS negative,
                  SUM(CASE WHEN route = 'agentic' THEN 1 ELSE 0 END) AS agentic,
                  AVG(latency_ms) AS avgLatency
             FROM qa_events WHERE created_at >= ?${scopedWhere}`
        )
        .get(since, ...scopedParams) as Record<string, number | null>

      const total = totals.total ?? 0

      // p50/p95:SQLite 没有百分位函数,用 LIMIT/OFFSET 取序位;只统计当前
      // 用户集合内的事件,与 totals 一致。
      const percentile = (p: number): number | null => {
        if (total === 0) return null
        const offset = Math.floor((total - 1) * p)
        const row = db
          .prepare(
            `SELECT latency_ms AS v FROM qa_events
              WHERE created_at >= ? AND latency_ms IS NOT NULL${scopedWhere}
              ORDER BY latency_ms LIMIT 1 OFFSET ?`
          )
          .get(since, ...scopedParams, offset) as { v: number } | undefined
        return row?.v ?? null
      }

      // 知识盲区:没答上来的问题聚合。
      const blindSpots = db
        .prepare(
          `SELECT question, COUNT(*) AS n
             FROM qa_events
            WHERE created_at >= ? AND answered = 0${scopedWhere}
            GROUP BY question
            ORDER BY n DESC LIMIT 20`
        )
        .all(since, ...scopedParams)

      const negativeTop = db
        .prepare(
          `SELECT question, feedback, created_at AS createdAt
             FROM qa_events
            WHERE created_at >= ? AND feedback IN ('not_helpful','wrong')${scopedWhere}
            ORDER BY created_at DESC LIMIT 20`
        )
        .all(since, ...scopedParams)

      // 长期零引用文档:按 scope 过滤后取 top 20。
      let unusedWhere = "d.status = 'ready'"
      const unusedParams: unknown[] = []
      if (claims.role !== 'admin') {
        const ctx = loadAccessContext(db, claims.sub)
        if (ctx.scopeIds.length === 0) {
          return reply.send(
            ok({
              windowDays: days,
              total: 0,
              unansweredRate: 0,
              negativeRate: 0,
              agenticRate: 0,
              latency: { avg: null, p50: null, p95: null },
              blindSpots: [],
              negativeTop: [],
              unusedDocs: [],
              docStats: []
            })
          )
        }
        unusedWhere += ` AND d.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})`
        unusedParams.push(...ctx.scopeIds)
      }
      const unusedDocs = db
        .prepare(
          `SELECT d.id, d.title, d.created_at AS createdAt
             FROM documents d
            WHERE ${unusedWhere}
              AND NOT EXISTS (
                SELECT 1 FROM qa_events e
                 WHERE e.cited_chunks IS NOT NULL
                   AND e.cited_chunks LIKE '%' || d.id || '%'
              )
            ORDER BY d.created_at LIMIT 20`
        )
        .all(...unusedParams)

      // 各 status 文档数:按 scope 过滤。
      let docStatsWhere = '1=1'
      const docStatsParams: unknown[] = []
      if (claims.role !== 'admin') {
        const ctx = loadAccessContext(db, claims.sub)
        if (ctx.scopeIds.length === 0) {
          docStatsWhere = '0=1'
        } else {
          docStatsWhere = `d.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})`
          docStatsParams.push(...ctx.scopeIds)
        }
      }
      const docStats = db
        .prepare(
          `SELECT status, COUNT(*) AS n
             FROM documents d WHERE ${docStatsWhere}
            GROUP BY status`
        )
        .all(...docStatsParams) as { status: string; n: number }[]

      return reply.send(
        ok({
          windowDays: days,
          total,
          unansweredRate: total ? (totals.unanswered ?? 0) / total : 0,
          negativeRate: total ? (totals.negative ?? 0) / total : 0,
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

// Zod schema 在 routes/auth.ts 已有 requireAdmin 守卫;此处再校验 zod 输入。
// 当前实现仅用 query.days,不做更严格的 shape 校验,保留 zod import 以备扩展。
void z
