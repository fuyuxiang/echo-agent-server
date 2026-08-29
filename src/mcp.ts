import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from './db/index.js'
import { loadAccessContext, canAccessScope, canAccessDocument } from './auth/scopes.js'
import { type JwtClaims } from './auth/jwt.js'
import { Retriever } from './kb/retrieve/index.js'
import type { RetrieverDeps } from './kb/retrieve/index.js'

/**
 * MCP Server(Streamable HTTP)。
 *
 * 让外部 AI 客户端(Cursor/Claude Desktop 等)能直接对接组织知识库,无需
 * 经过 echo-agent 桌面端。三个关键设计:
 *
 *   · 鉴权完全复用 REST —— MCP 端点不能脱离服务端既有的 RBAC,否则一个 Key
 *     泄露就能拖走整个组织库。鉴权失败返回 401,让客户端立即拒绝结果。
 *
 *   · token_version 实时校验 —— 直接复用 `makeAuthenticate`,与 /api/v1/*
 *     享有同一撤销机制:改密、改密级、禁用用户都会让旧 MCP token 立即失效。
 *
 *   · 权限再次内联 —— 工具层不能再信任调用者声明的 scope。每次调用都用
 *     token 解析出当前用户的可见 scope,SQL 条件与 /retrieve 一致。
 *     模型可能在工具描述里写"仅返回有权访问的内容",但这是自律不是边界。
 *
 * 会话管理:
 *   - 客户端 initialize 时服务端生成 sessionId,通过 mcp-session-id 头回传;
 *   - 后续 POST/GET/DELETE 携带同一 sessionId,服务端按会话复用 McpServer 实例;
 *   - DELETE 显式终止;无活动 5 分钟自动清理。
 */

interface McpDeps {
  db: DB
  retriever: Retriever
  config: RetrieverDeps['cfg']
  embedder: RetrieverDeps['embedder']
  reranker: RetrieverDeps['reranker']
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  /**
   * 无状态传输。
   *
   * 每个请求一个 transport:有状态传输需要会话管理(Init 之后才接收请求,
   * 超时清理等),对一次性调用过于复杂,且会让客户端实现必须跟踪 sessionId。
   * 这里用 Streamable HTTP 的"无状态"模式 —— 每个请求都当一次新的会话。
   */
  /**
   * 会话池:key = sessionId,value = { server, transport, userId, lastUsed }。
   * 5 分钟无活动自动 GC;DELETE 显式终止。
   */
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport; userId: string; lastUsed: number }
  >()
  const SESSION_TTL_MS = 5 * 60_000

  function gcSessions(): void {
    const now = Date.now()
    for (const [sid, s] of sessions) {
      if (now - s.lastUsed > SESSION_TTL_MS) {
        void s.transport.close().catch(() => undefined)
        void s.server.close().catch(() => undefined)
        sessions.delete(sid)
      }
    }
  }

  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    gcSessions()
    const auth = await requireAuth(req, reply, deps.db)
    if (!auth) return

    const sessionHeader = req.headers['mcp-session-id']
    const existingSid = typeof sessionHeader === 'string' ? sessionHeader : undefined
    const existing = existingSid ? sessions.get(existingSid) : undefined

    if (existing && existing.userId !== auth.userId) {
      // 同一 sessionId 被另一个用户复用:直接拒绝(防止会话劫持)。
      reply.code(403).send({ error: { code: 4031, msg: 'session 与当前用户不匹配' } })
      return
    }

    let server: McpServer
    let transport: StreamableHTTPServerTransport
    let sid: string

    if (existing) {
      server = existing.server
      transport = existing.transport
      sid = existingSid!
      existing.lastUsed = Date.now()
    } else {
      server = buildServer(deps, auth.userId)
      sid = randomUUID()
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sid
      })
      await server.connect(transport)
      sessions.set(sid, { server, transport, userId: auth.userId, lastUsed: Date.now() })
      // 把 sessionId 暴露到响应头(initialize 响应会带;后续通知也用)。
      reply.hijack()
      ;(reply.raw as unknown as { setHeader: (k: string, v: string) => void }).setHeader(
        'mcp-session-id',
        sid
      )
    }

    try {
      await transport.handleRequest(req.raw, reply.raw, req.body)
    } finally {
      // initialize 完成后 transport 才接管;关闭由会话 GC 处理。
      // 仅在客户端主动 DELETE 时才立即关闭;普通调用完成后让会话复用。
      void 0
    }
  })

  app.delete('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAuth(req, reply, deps.db)
    if (!auth) return
    const sid = req.headers['mcp-session-id']
    if (typeof sid !== 'string') {
      reply.code(400).send({ error: { code: 4001, msg: '缺少 mcp-session-id' } })
      return
    }
    const s = sessions.get(sid)
    if (!s) {
      reply.code(404).send({ error: { code: 4041, msg: '会话不存在或已过期' } })
      return
    }
    if (s.userId !== auth.userId) {
      reply.code(403).send({ error: { code: 4031, msg: '无权终止该会话' } })
      return
    }
    await s.transport.close().catch(() => undefined)
    await s.server.close().catch(() => undefined)
    sessions.delete(sid)
    reply.code(204).send()
  })
}

function buildServer(deps: McpDeps, userId: string): McpServer {
  const server = new McpServer({
    name: 'echo-org-kb',
    version: '1'
  })

  // ── org_search ────────────────────────────────────────────────────────
  // 与 /retrieve 同语义:权限内联,失败降级到 RRF,精排超时不阻断。
  server.tool(
    'org_search',
    '按查询在组织知识库中检索,返回带原文引用的材料片段。' +
      '权限内联:仅返回当前用户可见范围内的内容,无法绕过。',
    {
      query: z.string().min(1).describe('搜索问题'),
      limit: z.number().int().min(1).max(50).default(8).describe('返回条数'),
      multi_hop: z.boolean().default(false).describe('是否升级到多跳')
    },
    async ({ query, limit, multi_hop }) => {
      const res = await deps.retriever.retrieve(userId, {
        query,
        limit,
        multiHop: multi_hop
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              chunks: res.chunks.map((c) => ({
                id: c.chunkId,
                chunkId: c.chunkId,
                docId: c.docId,
                doc: c.docTitle,
                title: c.docTitle,
                page: c.citation.page,
                heading: c.citation.heading,
                citation: c.citation,
                openUrl: c.citation.openUrl,
                text: c.text,
                score: c.score,
                stale: c.stale
              })),
              memories: res.memories,
              diagnostics: res.diagnostics
            })
          }
        ]
      }
    }
  )

  // ── org_fetch_doc ────────────────────────────────────────────────────
  server.tool(
    'org_fetch_doc',
    '按 id 取组织文档的完整内容或指定页。仅可访问当前用户有权看的文档。',
    {
      doc_id: z.string().min(1).describe('文档 id'),
      page: z.number().int().min(1).optional().describe('页码(可选)')
    },
    async ({ doc_id, page }) => {
      const ctx = loadAccessContext(deps.db, userId)
      if (!canAccessDocument(deps.db, ctx, doc_id)) {
        return { isError: true, content: [{ type: 'text' as const, text: '文档不存在或无权访问' }] }
      }

      const row = deps.db
        .prepare('SELECT title, source_type, status FROM documents WHERE id = ?')
        .get(doc_id) as
        | { title: string; source_type: string; status: string }
        | undefined
      if (!row) {
        return { isError: true, content: [{ type: 'text' as const, text: '文档不存在' }] }
      }

      const sql = page
        ? 'SELECT text, seq FROM chunks WHERE doc_id = ? AND (loc_page = ? OR loc_page IS NULL) ORDER BY seq'
        : 'SELECT text, seq FROM chunks WHERE doc_id = ? ORDER BY seq'
      const params = page ? [doc_id, page] : [doc_id]
      const rows = deps.db.prepare(sql).all(...params) as { text: string; seq: number }[]
      const body = rows.map((r) => r.text).join('\n\n')
      return {
        content: [
          { type: 'text' as const, text: body || `${row.title}\n\n(暂无内容)` }
        ]
      }
    }
  )

  // ── org_list_docs ────────────────────────────────────────────────────
  server.tool(
    'org_list_docs',
    '列出当前用户可见范围内的组织文档。',
    {
      scope_id: z.string().optional().describe('按可见范围筛选'),
      keyword: z.string().optional().describe('按标题关键词搜索'),
      limit: z.number().int().min(1).max(100).default(20)
    },
    async ({ scope_id, keyword, limit }) => {
      const ctx = loadAccessContext(deps.db, userId)
      if (ctx.scopeIds.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ items: [] }) }] }
      }

      // MCP 是新的对外接口,权限与 /api/v1/docs 保持一致 —— 否则两个列表
      // 给出的范围不一样会让人怀疑系统是否一致。
      const where: string[] = [
        'd.scope_id IN (' + ctx.scopeIds.map(() => '?').join(',') + ')',
        'd.sensitivity <= ?',
        "d.status != 'archived'"
      ]
      const params: unknown[] = [...ctx.scopeIds, ctx.clearance]
      if (scope_id) {
        // 客户传一个不可见的 scope 直接拒绝 —— 不要"看似有效但实际为空"
        if (!canAccessScope(ctx, scope_id)) {
          return { isError: true, content: [{ type: 'text' as const, text: '无权访问该范围' }] }
        }
        where.push('d.scope_id = ?')
        params.push(scope_id)
      }
      if (keyword) {
        where.push('d.title LIKE ?')
        params.push(`%${keyword}%`)
      }
      const rows = deps.db
        .prepare(
          `SELECT d.id, d.title, d.source_type AS sourceType, d.status, d.updated_at AS updatedAt,
                  (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunkCount,
                  s.kind AS scopeKind, s.name AS scopeName
             FROM documents d
             LEFT JOIN document_families df ON df.id = d.family_id
             JOIN v_effective_scopes s ON s.id = d.scope_id
            WHERE ${where.join(' AND ')}
              AND (d.family_id IS NULL OR
                   (df.current_document_id = d.id AND df.state = 'active'))
            ORDER BY d.updated_at DESC LIMIT ?`
        )
        .all(...params, limit) as Record<string, unknown>[]

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ items: rows }) }]
      }
    }
  )

  // ── org_who_knows ───────────────────────────────────────────────────
  server.tool(
    'org_who_knows',
    '针对某个主题,找出在范围内的文档维护人。回答"这事该问谁"用。',
    { topic: z.string().min(1) },
    async ({ topic }) => {
      const ctx = loadAccessContext(deps.db, userId)
      if (ctx.scopeIds.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ people: [] }) }] }
      }

      // 用 FTS5 找含 topic 的文档,再按 owner 聚合 —— 这是在范围内的"谁
      // 在维护相关材料"的最佳近似。
      const match = topic
        .replace(/["*():^-]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2)
        .map((t) => `"${t}"`)
        .join(' OR ')

      let rows: { id: string; name: string; n: number }[] = []
      if (match) {
        try {
          rows = deps.db
            .prepare(
              `WITH hit AS (
                 SELECT DISTINCT d.id, d.owner_id AS ownerId
                   FROM chunks_fts f
                   JOIN embedding_meta em ON em.fts_rowid = f.rowid
                   JOIN chunks c ON c.id = em.chunk_id
                   JOIN documents d ON d.id = c.doc_id
                  WHERE chunks_fts MATCH ?
                    AND d.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})
                    AND d.sensitivity <= ?
                    AND d.status = 'ready'
                    AND d.owner_id IS NOT NULL
               )
               SELECT u.id, u.display_name AS name, COUNT(*) AS n
                 FROM hit
                 JOIN users u ON u.id = hit.ownerId
                WHERE u.status = 'active'
                GROUP BY u.id
                ORDER BY n DESC
                LIMIT 5`
            )
            .all(match, ...ctx.scopeIds, ctx.clearance) as typeof rows
        } catch {
          rows = []
        }
      }
      if (rows.length === 0) {
        // 没人匹配专题词时,退而求其次:范围内文档最多的维护人
        rows = deps.db
          .prepare(
            `SELECT u.id, u.display_name AS name, COUNT(d.id) AS n
               FROM users u
               JOIN documents d ON d.owner_id = u.id
              WHERE d.scope_id IN (${ctx.scopeIds.map(() => '?').join(',')})
                AND d.status = 'ready'
                AND d.sensitivity <= ?
                AND u.status = 'active'
              GROUP BY u.id
              ORDER BY n DESC LIMIT 5`
          )
          .all(...ctx.scopeIds, ctx.clearance) as typeof rows
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              people: rows.map((r) => ({ ...r, reason: '范围内该主题文档的维护人' }))
            })
          }
        ]
      }
    }
  )

  // ── org_submit_knowledge ───────────────────────────────────────────
  // MCP 端提交的知识必须进 promotions(待审),不能直接入库 —— 否则审核流就
  // 被旁路了。
  server.tool(
    'org_submit_knowledge',
    '把一条候选知识提交到组织知识库审核队列。不直接入库,需管理员审核。',
    {
      kind: z.enum(['fact', 'decision', 'convention', 'pitfall', 'howto']),
      content: z.string().min(1).max(2000),
      rationale: z.string().max(2000).optional(),
      target_scope: z.string().describe('目标可见性单元 id')
    },
    async ({ kind, content, rationale, target_scope }) => {
      const ctx = loadAccessContext(deps.db, userId)
      if (!canAccessScope(ctx, target_scope)) {
        return { isError: true, content: [{ type: 'text' as const, text: '无权向该范围提交' }] }
      }

      const id = randomUUID()
      try {
        deps.db
          .prepare(
            `INSERT INTO promotions (id, submitter_id, target_scope, payload_type, payload,
                                     source, state, created_at)
             VALUES (?,?,?,'memory',?,?,'pending',?)`
          )
          .run(
            id,
            userId,
            target_scope,
            JSON.stringify({ kind, content, rationale }),
            'manual',
            Date.now()
          )
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `提交失败:${(e as Error).message}` }]
        }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ promotionId: id, state: 'pending' })
          }
        ]
      }
    }
  )

  return server
}

/**
 * 鉴权与 /api/v1/* 共用逻辑,但失败时返回 401 而不是 403 —— MCP 客户端
 * 通常看到 401 会主动停止重试,403 则会重试同样的请求。
 *
 * 实现上直接复用 `makeAuthenticate`,这样:
 *   - JWT 签名校验;
 *   - 数据库 token_version 实时比对;
 *   - 用户状态(active)校验;
 *   - 角色从库读(防止 token 中过期角色被信任)。
 *
 * 与 /api/v1/* 的唯一差异是错误响应体形状 —— MCP 客户端期望
 * {error:{code,msg}},而 REST 走 ok/fail 包装。
 */
async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  db: DB
): Promise<{ userId: string; claims: JwtClaims } | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: { code: 4011, msg: '需要 Bearer token' } })
    return null
  }

  // 先做 JWT 验签,拿到 claims。
  let claims: JwtClaims
  try {
    claims = await req.jwtVerify<JwtClaims>()
  } catch {
    reply.code(401).send({ error: { code: 4011, msg: 'token 无效或已过期' } })
    return null
  }

  // 再做 token_version / status / role 的实时比对 —— 与 REST 路径一致,
  // 禁用用户或 token_version 已递增的旧 token 一律 401。
  const row = db
    .prepare("SELECT token_version AS tv, status, role FROM users WHERE id = ?")
    .get(claims.sub) as
    | { tv: number; status: string; role: string }
    | undefined
  if (!row || row.status !== 'active') {
    reply.code(401).send({ error: { code: 4013, msg: '账号不存在或已禁用' } })
    return null
  }
  if (row.tv !== claims.tv) {
    reply.code(401).send({ error: { code: 4014, msg: '登录状态已失效,请重新登录' } })
    return null
  }
  // 角色以库为准,避免 token 携带过期角色。
  const finalClaims: JwtClaims = { ...claims, role: row.role as JwtClaims['role'] }
  return { userId: claims.sub, claims: finalClaims }
}
