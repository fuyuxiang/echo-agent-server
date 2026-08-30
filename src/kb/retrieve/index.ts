import type { DB } from '../../db/index.js'
import type { Config } from '../../config.js'
import type { Embedder } from '../../models/embedder.js'
import type { Reranker } from '../../models/reranker.js'
import { rerankSafely, lexicalOverlapScore } from '../../models/reranker.js'
import { loadAccessContext, type AccessContext } from '../../auth/scopes.js'
import {
  bm25Search,
  vectorSearch,
  searchMemories,
  RECALL_LIMIT,
  type Candidate,
  type MemoryHit,
  type RecallFilters
} from './recall.js'
import { fuseRRF, capPerDocument, type FusedCandidate } from './fuse.js'
import { estimateTokens } from './text.js'

export interface RetrieveRequest {
  query: string
  limit?: number
  filters?: RecallFilters
  /** 多跳:生成子查询分别召回后合并。由客户端的 router 判定后传入。 */
  multiHop?: boolean
  tokenBudget?: number
  /**
   * 显式 scope 子集。undefined = 服务端按用户实时可见全集;
   * `['org']` = 仅组织层;`['team']` = 仅用户可见的团队层;'local' 不应在这里传。
   *
   * 即使客户端传入,服务端仍按"用户可见 scope � 请求 scope"做交集,
   * 防止越权。
   */
  scopes?: Array<'personal' | 'org' | 'team'>
  /** 显式 scope id 子集；只能从实时授权范围中继续收窄。 */
  scopeIds?: string[]
}

export interface Citation {
  page: number | null
  heading: string
  startMs: number | null
  endMs: number | null
  openUrl: string
}

export interface RetrievedChunk {
  chunkId: string
  docId: string
  docTitle: string
  text: string
  score: number
  scopeKind: string
  modality: string
  sourceType: string
  /** L1/L2/L3 来源层级。L1 由桌面端合并层补,服务端只发 L2/L3。 */
  source?: 'L1' | 'L2' | 'L3'
  citation: Citation
  owner: { id: string; displayName: string } | null
  stale: boolean
  updatedAt: number
}

export interface SuggestedPerson {
  userId: string
  displayName: string
  reason: string
}

export interface RetrieveResponse {
  chunks: RetrievedChunk[]
  memories: MemoryHit[]
  suggestAsk?: SuggestedPerson[]
  diagnostics: {
    bm25Hits: number
    vecHits: number
    fusedCandidates: number
    rerankMs: number
    rerankSkipped: boolean
    totalMs: number
    subQueries?: string[]
  }
}

const DEFAULT_LIMIT = 8
const DEFAULT_TOKEN_BUDGET = 6000
const RERANK_POOL = 100
const MAX_CHUNKS_PER_DOC = 3

/**
 * 相关度下限。
 *
 * 向量检索永远返回 k 个最近邻,无论多不相关 —— 问"量子计算机采购预算"
 * 也会捞回"弹性工作制",因为那是库里最近的东西。没有下限的后果不是
 * 多几条噪音,而是模型永远拿到"材料",于是从无关内容里编答案,而不肯
 * 说"没找到"。这条阈值是"诚实说不知道"能力的前提。
 *
 * 取值偏保守:宁可漏掉边缘命中,也不要污染答案。精排可用时用精排分数
 * (0..1 的相关度),否则用词汇重叠兜底 —— RRF 分数是名次倒数之和,
 * 与相关度无关,不能直接当阈值用。
 */
export const MIN_RELEVANCE = 0.08

export interface RetrieverDeps {
  db: DB
  cfg: Config
  embedder: Embedder
  reranker: Reranker
  log?: { warn(m: string): void }
}

export class Retriever {
  constructor(private deps: RetrieverDeps) {}

  async retrieve(userId: string, req: RetrieveRequest): Promise<RetrieveResponse> {
    const t0 = Date.now()
    const ctx = loadAccessContext(this.deps.db, userId)

    // 无可见 scope(用户被禁用或不属于任何组且无 org scope):直接空结果。
    if (ctx.scopeIds.length === 0) {
      return this.empty(t0)
    }

    // 服务端按"用户可见 scope � 客户端请求 scope"二次收敛。
    // 即使客户端误传越权 scope,这里也会被裁掉。
    if (req.scopes && req.scopes.length > 0) {
      const kindOf = (sid: string): 'personal' | 'org' | 'team' | null => {
        const r = this.deps.db
          .prepare('SELECT kind FROM v_effective_scopes WHERE id = ?')
          .get(sid) as { kind: string } | undefined
        if (!r) return null
        return r.kind === 'org' || r.kind === 'team' || r.kind === 'personal'
          ? (r.kind as 'org' | 'team' | 'personal')
          : null
      }
      const filtered: string[] = []
      for (const sid of ctx.scopeIds) {
        const kind = kindOf(sid)
        if (kind !== null && req.scopes.includes(kind)) filtered.push(sid)
      }
      if (filtered.length === 0) {
        return this.empty(t0)
      }
      // 重写 ctx.scopeIds,后续 SQL 内联权限使用新值。
      ;(ctx as { scopeIds: string[] }).scopeIds = filtered
    }
    if (req.scopeIds && req.scopeIds.length > 0) {
      const requested = new Set(req.scopeIds)
      const filtered = ctx.scopeIds.filter((id) => requested.has(id))
      if (filtered.length === 0) return this.empty(t0)
      ;(ctx as { scopeIds: string[] }).scopeIds = filtered
    }

    const queries = req.multiHop ? this.subQueries(req.query) : [req.query]
    const limit = req.limit ?? DEFAULT_LIMIT

    let bm25Total = 0
    let vecTotal = 0
    const perQuery: FusedCandidate[][] = []

    for (const q of queries) {
      // 两路召回并行。向量路的嵌入调用可能失败(远端 API 抖动),
      // 此时保留 BM25 结果继续 —— 单路可用比整体失败好。
      const [kw, vec] = await Promise.all([
        Promise.resolve().then(() =>
          bm25Search(this.deps.db, q, ctx, RECALL_LIMIT, req.filters)
        ),
        this.vectorRecall(q, ctx, req.filters)
      ])
      bm25Total += kw.length
      vecTotal += vec.length
      perQuery.push(
        fuseRRF([
          { name: 'bm25', items: kw },
          { name: 'vector', items: vec }
        ])
      )
    }

    // 多个子查询的结果再融合一次:按各自融合后的名次做 RRF。
    const merged =
      perQuery.length === 1
        ? perQuery[0]
        : fuseRRF(
            perQuery.map((items, i) => ({
              name: `q${i}`,
              items: items.map((c, idx) => ({ ...c, rank: idx + 1 }))
            }))
          )

    // 先精排再做文档多样性。若在精排前按 BM25/RRF 名次截同文档，标题块
    // 很容易挤掉真正包含金额/步骤的正文块，导致“找到了文档却没有证据”。
    const pool = merged.slice(0, RERANK_POOL)

    // 精排
    const rerankT0 = Date.now()
    const ranked = await rerankSafely(
      this.deps.reranker,
      req.query,
      pool.map((c) => ({ id: c.chunkId, text: this.relevanceText(c) })),
      undefined,
      (e) => this.deps.log?.warn(`rerank 降级: ${String(e)}`)
    )
    const rerankMs = Date.now() - rerankT0
    const rerankSkipped = ranked === null

    const ordered = rerankSkipped
      ? pool
      : this.applyRerank(pool, ranked as { id: string; score: number }[])

    // 过滤明显不相关的候选。精排跳过时用词汇重叠兜底打分,因为 RRF 分数
    // 是名次倒数之和,与"有多相关"无关 —— 库里最不相关的文档也能拿到
    // 1/(60+1) 的高名次分。
    const relevant = this.filterByRelevance(
      ordered,
      req.query,
      rerankSkipped,
      req.multiHop === true
    )

    const diverse = capPerDocument(relevant, MAX_CHUNKS_PER_DOC)
    const chunks = this.assemble(
      diverse.slice(0, limit),
      req.tokenBudget ?? DEFAULT_TOKEN_BUDGET
    )
    const memories = searchMemories(this.deps.db, req.query, ctx, 5)

    const response: RetrieveResponse = {
      chunks,
      memories,
      diagnostics: {
        bm25Hits: bm25Total,
        vecHits: vecTotal,
        fusedCandidates: merged.length,
        rerankMs,
        rerankSkipped,
        totalMs: Date.now() - t0,
        ...(queries.length > 1 ? { subQueries: queries } : {})
      }
    }

    // 无结果时给出"该问谁",这比一句"没找到"有用得多。
    if (chunks.length === 0 && memories.length === 0) {
      response.suggestAsk = this.suggestAsk(req.query, ctx)
    }
    return response
  }

  private async vectorRecall(
    q: string,
    ctx: AccessContext,
    filters?: RecallFilters
  ): Promise<Candidate[]> {
    try {
      const vec = await this.deps.embedder.embed(q)
      return vectorSearch(this.deps.db, vec, ctx, RECALL_LIMIT, filters)
    } catch (e) {
      this.deps.log?.warn(`向量召回降级(仅 BM25): ${String(e)}`)
      return []
    }
  }

  /**
   * 子查询拆分。规则式,不调模型 —— 调模型会给首 token 再加一次往返。
   * 按并列连词与问号切,过短的片段丢弃。
   */
  private subQueries(query: string): string[] {
    const parts = query
      .split(/[?？；;]|(?:\s*(?:以及|并且|同时|还有)\s*)/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4)
    const uniq = [...new Set([query, ...parts])]
    return uniq.slice(0, 3)
  }

  private applyRerank(
    pool: FusedCandidate[],
    ranked: { id: string; score: number }[]
  ): (FusedCandidate & { rerankScore?: number })[] {
    const scores = new Map(ranked.map((r) => [r.id, r.score]))
    return [...pool]
      .map((c) => ({ ...c, rerankScore: scores.get(c.chunkId) ?? 0 }))
      .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
  }

  /**
   * 剔除不相关候选,让"没找到"成为可能的答案。
   *
   * BM25 只是召回信号，不是证据充分性证明。所有候选（包括
   * BM25 命中）都必须过精排或可解释的词汇重叠阈值。
   */
  private filterByRelevance(
    items: (FusedCandidate & { rerankScore?: number })[],
    query: string,
    rerankSkipped: boolean,
    multiHop: boolean
  ): (FusedCandidate & { rerankScore?: number })[] {
    const scored = items.map((candidate) => ({
      candidate,
      score: rerankSkipped
        ? lexicalOverlapScore(query, this.relevanceText(candidate))
        : (candidate.rerankScore ?? 0)
    }))
    // 开发/降级词汇精排没有语义能力，低到 0.08 的偶然二字重合会把
    // “月球基地班车”错误关联到“班车安排”。单主题必须覆盖近半查询，
    // 并保留接近 top 分的候选；显式多跳允许各文档只覆盖一个子问题。
    const lexicalMode = rerankSkipped || !this.deps.reranker.crossEncoder
    if (!lexicalMode) {
      return scored
        .filter(({ score }) => score >= MIN_RELEVANCE)
        .map(({ candidate }) => candidate)
    }
    const absolute = multiHop ? 0.18 : 0.45
    const top = scored[0]?.score ?? 0
    const relative = multiHop ? absolute : Math.max(absolute, top * 0.75)
    const anchorDocs = new Set(
      scored
        .filter(({ score }) => score >= relative)
        .map(({ candidate }) => candidate.docId)
    )
    return scored
      .filter(({ score, candidate }) => score >= relative || anchorDocs.has(candidate.docId))
      .map(({ candidate }) => candidate)
  }

  private relevanceText(candidate: Candidate): string {
    return `${candidate.docTitle}\n${candidate.heading ?? ''}\n${candidate.text}`
  }

  private assemble(
    items: (FusedCandidate & { rerankScore?: number })[],
    tokenBudget: number
  ): RetrievedChunk[] {
    const staleMs = this.deps.cfg.staleDays * 24 * 3600_000
    const now = Date.now()
    const out: RetrievedChunk[] = []
    let used = 0

    for (const c of items) {
      const cost = estimateTokens(c.text)
      // 至少放一条,否则超长单 chunk 会让答案完全没有材料。
      if (used + cost > tokenBudget && out.length > 0) break
      used += cost

      out.push({
        chunkId: c.chunkId,
        docId: c.docId,
        docTitle: c.docTitle,
        text: c.text,
        score: c.rerankScore ?? c.fusedScore,
        scopeKind: c.scopeKind,
        modality: c.modality,
        sourceType: c.sourceType,
        // 来源层级:L2 = 团队,L3 = 组织。L1 由桌面端合并层补。
        source: c.scopeKind === 'personal' ? 'L1' : c.scopeKind === 'team' ? 'L2' : 'L3',
        citation: {
          page: c.locPage,
          heading: c.heading ?? '',
          startMs: c.locStartMs,
          endMs: c.locEndMs,
          openUrl: buildOpenUrl(c)
        },
        owner: c.ownerId
          ? { id: c.ownerId, displayName: c.ownerName ?? '' }
          : null,
        stale: c.volatility === 'volatile' && now - c.updatedAt > staleMs,
        updatedAt: c.updatedAt
      })
    }
    return out
  }

  /** 按主题词找文档 owner。没有命中文档时也能给出方向。 */
  private suggestAsk(query: string, ctx: AccessContext): SuggestedPerson[] {
    const topicHits = bm25Search(this.deps.db, query, ctx, 30)
    const owners = new Map<string, { userId: string; displayName: string; titles: Set<string>; hits: number }>()
    for (const hit of topicHits) {
      if (!hit.ownerId || !hit.ownerName) continue
      const current = owners.get(hit.ownerId) ?? {
        userId: hit.ownerId,
        displayName: hit.ownerName,
        titles: new Set<string>(),
        hits: 0
      }
      current.hits += 1
      current.titles.add(hit.docTitle)
      owners.set(hit.ownerId, current)
    }
    // 新主题可能尚未入库，严格主题检索此时没有 owner。退回到用户有权
    // 看到的最近知识维护人，而不是返回空白或跨权限猜联系人。
    if (owners.size === 0 && ctx.scopeIds.length > 0) {
      const placeholders = ctx.scopeIds.map(() => '?').join(',')
      const rows = this.deps.db.prepare(`
        SELECT d.owner_id AS ownerId, u.display_name AS ownerName,
               d.title AS docTitle
          FROM documents d
          JOIN users u ON u.id = d.owner_id AND u.status = 'active'
         WHERE d.scope_id IN (${placeholders})
           AND d.sensitivity <= ?
           AND d.status = 'ready'
         ORDER BY d.updated_at DESC
         LIMIT 30
      `).all(...ctx.scopeIds, ctx.clearance) as Array<{
        ownerId: string
        ownerName: string
        docTitle: string
      }>
      for (const row of rows) {
        const current = owners.get(row.ownerId) ?? {
          userId: row.ownerId,
          displayName: row.ownerName,
          titles: new Set<string>(),
          hits: 0
        }
        current.hits += 1
        current.titles.add(row.docTitle)
        owners.set(row.ownerId, current)
      }
    }
    return [...owners.values()]
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 3)
      .map((owner) => ({
        userId: owner.userId,
        displayName: owner.displayName,
        reason: topicHits.length > 0
          ? `维护与问题主题相关的文档：${[...owner.titles].slice(0, 2).join('、')}`
          : `可咨询的知识维护人，最近维护：${[...owner.titles].slice(0, 2).join('、')}`
      }))
  }

  private empty(t0: number): RetrieveResponse {
    return {
      chunks: [],
      memories: [],
      diagnostics: {
        bm25Hits: 0,
        vecHits: 0,
        fusedCandidates: 0,
        rerankMs: 0,
        rerankSkipped: false,
        totalMs: Date.now() - t0
      }
    }
  }
}

function buildOpenUrl(c: Candidate): string {
  if (c.locStartMs !== null) return `echo://doc/${c.docId}/t/${c.locStartMs}`
  if (c.locPage !== null) return `echo://doc/${c.docId}/page/${c.locPage}`
  return `echo://doc/${c.docId}`
}
