import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AuthedRequest } from '../auth/jwt.js'
import type { RetrievedChunk, RetrieveResponse } from '../kb/retrieve/index.js'
import { RRF_K } from '../kb/retrieve/fuse.js'
import { estimateTokens } from '../kb/retrieve/text.js'
import {
  assessEvidence,
  evidenceFromChunks,
  fallbackPlan,
  fallbackFollowUpQueries,
  generateAnswerDraft,
  planQuestion,
  renderClaims,
  verifyClaims,
  type AgenticAssessment,
  type AgenticPlan,
  type AskMode
} from '../kb/agentic.js'
import { fail } from '../reply.js'

const AskSchema = z.object({
  question: z.string().min(1).max(8000),
  conversationId: z.string().max(200).optional(),
  scopeKinds: z.array(z.enum(['personal', 'team', 'org'])).max(3).optional(),
  scopeIds: z.array(z.string()).max(100).optional(),
  mode: z.enum(['fast', 'deep', 'auto']).default('auto'),
  filters: z.object({
    tags: z.array(z.string()).max(50).optional(),
    sourceTypes: z.array(z.string()).max(30).optional()
  }).optional()
})

interface AskCitation {
  id: string
  docId: string
  chunkId: string
  title: string
  scopeKind: string
  page: number | null
  heading: string
  quote: string
  openUrl: string
  stale: boolean
}

interface AskClaim {
  text: string
  citationIds: string[]
  verification: 'supported'
}

interface AskFinal {
  answer: string
  claims: AskClaim[]
  citations: AskCitation[]
  confidence: number
  insufficient: boolean
  suggestedPeople: unknown[]
  traceId: string
  qaEventId?: string
  mode: AskMode
  verification: 'supported' | 'extractive_fallback' | 'insufficient' | 'stale_only'
  agentic?: {
    planner: AgenticPlan['source']
    assessor: AgenticAssessment['source']
    rounds: number
    queries: number
  }
}

function quoteOf(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  // 320 字经常只够放标题和背景，真正的金额/例外落在 quote 之外，用户看见
  // 引用却无法当场核验。1200 字通常覆盖完整 chunk，同时仍限制 SSE 体积。
  return compact.length > 1200 ? `${compact.slice(0, 1197)}…` : compact
}

function citationsFrom(chunks: RetrievedChunk[]): AskCitation[] {
  return chunks.map((chunk, index) => ({
    id: `cit-${index + 1}`,
    docId: chunk.docId,
    chunkId: chunk.chunkId,
    title: chunk.docTitle,
    scopeKind: chunk.scopeKind,
    page: chunk.citation.page,
    heading: chunk.citation.heading,
    // quote 只从授权后的原始 chunk 截取，模型没有生成或改写它的权限。
    quote: quoteOf(chunk.text),
    openUrl: chunk.citation.openUrl,
    stale: chunk.stale
  }))
}

const MAX_EVIDENCE_CHUNKS = 16
const MAX_EVIDENCE_TOKENS = 10_000
const MAX_EVIDENCE_PER_DOC = 4

/** 跨查询合并后再次执行全局多样性与 token 预算，避免 Agentic 多查询把
 * 48 个 chunk 全部塞给生成模型，导致关键证据被长上下文淹没。 */
function mergeRetrievals(results: RetrieveResponse[]): RetrieveResponse {
  const chunks = new Map<string, { chunk: RetrievedChunk; fusedScore: number }>()
  const memories = new Map<string, RetrieveResponse['memories'][number]>()
  for (const result of results) {
    result.chunks.forEach((chunk, index) => {
      const prior = chunks.get(chunk.chunkId)
      const contribution = 1 / (RRF_K + index + 1)
      if (!prior) {
        chunks.set(chunk.chunkId, { chunk, fusedScore: contribution })
      } else {
        prior.fusedScore += contribution
        if (chunk.score > prior.chunk.score) prior.chunk = chunk
      }
    })
    for (const memory of result.memories) memories.set(memory.id, memory)
  }
  const counts = new Map<string, number>()
  const selected: RetrievedChunk[] = []
  let usedTokens = 0
  for (const item of [...chunks.values()].sort((a, b) =>
    Number(a.chunk.stale) - Number(b.chunk.stale) ||
    b.fusedScore - a.fusedScore ||
    b.chunk.score - a.chunk.score
  )) {
    const chunk = item.chunk
    if ((counts.get(chunk.docId) ?? 0) >= MAX_EVIDENCE_PER_DOC) continue
    const cost = estimateTokens(chunk.text)
    if (usedTokens + cost > MAX_EVIDENCE_TOKENS && selected.length > 0) continue
    selected.push(chunk)
    usedTokens += cost
    counts.set(chunk.docId, (counts.get(chunk.docId) ?? 0) + 1)
    if (selected.length >= MAX_EVIDENCE_CHUNKS) break
  }
  const suggested = new Map<string, NonNullable<RetrieveResponse['suggestAsk']>[number]>()
  for (const person of results.flatMap((result) => result.suggestAsk ?? [])) {
    if (!suggested.has(person.userId)) suggested.set(person.userId, person)
  }
  return {
    chunks: selected,
    memories: [...memories.values()],
    suggestAsk: [...suggested.values()].slice(0, 3),
    diagnostics: results.length > 0 ? {
      bm25Hits: results.reduce((sum, result) => sum + result.diagnostics.bm25Hits, 0),
      vecHits: results.reduce((sum, result) => sum + result.diagnostics.vecHits, 0),
      fusedCandidates: results.reduce((sum, result) => sum + result.diagnostics.fusedCandidates, 0),
      rerankMs: results.reduce((sum, result) => sum + result.diagnostics.rerankMs, 0),
      rerankSkipped: results.some((result) => result.diagnostics.rerankSkipped),
      totalMs: results.reduce((sum, result) => sum + result.diagnostics.totalMs, 0)
    } : {
      bm25Hits: 0, vecHits: 0, fusedCandidates: 0,
      rerankMs: 0, rerankSkipped: false, totalMs: 0
    }
  }
}

function extractiveAnswer(
  citations: AskCitation[],
  chunks: RetrievedChunk[]
): { answer: string; claims: AskClaim[] } {
  const used = citations.slice(0, 4)
  const fullText = new Map(chunks.map((chunk) => [chunk.chunkId, chunk.text]))
  const excerpt = (citation: AskCitation): string => {
    const compact = (fullText.get(citation.chunkId) ?? citation.quote).replace(/\s+/g, ' ').trim()
    return compact.length > 2000 ? `${compact.slice(0, 1997)}…` : compact
  }
  return {
    answer: used.map((citation) => `- ${excerpt(citation)} [${citation.id}]`).join('\n'),
    claims: used.map((c) => ({
      text: excerpt(c),
      citationIds: [c.id],
      verification: 'supported' as const
    }))
  }
}

function sse(raw: import('node:http').ServerResponse, event: string, data: unknown): void {
  if (raw.destroyed || raw.writableEnded) return
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function answerDeltas(answer: string, size = 160): string[] {
  const characters = Array.from(answer)
  const chunks: string[] = []
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(''))
  }
  return chunks
}

export function registerKnowledgeAskRoutes(app: FastifyInstance): void {
  const { db, cfg, retriever } = app.deps
  app.post(
    '/api/v1/knowledge/ask',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: cfg.rateLimitLlmPerMin > 0 ? cfg.rateLimitLlmPerMin : 1000,
          timeWindow: '1 minute',
          keyGenerator: (req) => (req as AuthedRequest).claims?.sub ?? req.ip
        }
      }
    },
    async (req, reply) => {
      const parsed = AskSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message}`))
      }
      const claims = (req as AuthedRequest).claims
      const input = parsed.data
      const traceId = randomUUID()
      const qaId = randomUUID()
      const provisionalPlan = fallbackPlan(input.question, input.mode)
      let mode: AskMode = provisionalPlan.mode
      const startedAt = Date.now()
      reply.hijack()
      reply.raw.statusCode = 200
      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8')
      reply.raw.setHeader('cache-control', 'no-cache, no-transform')
      reply.raw.setHeader('connection', 'keep-alive')
      reply.raw.setHeader('x-accel-buffering', 'no')
      reply.raw.flushHeaders()
      // 先发可用的确定性路由，保证首字节不被规划模型延迟；规划完成后用
      // route 事件确认最终模式。旧客户端忽略新事件也仍能正常工作。
      sse(reply.raw, 'meta', { traceId, mode, qaEventId: qaId, planning: true })
      sse(reply.raw, 'status', { stage: 'planning', message: '正在分析问题并规划证据检索' })

      const clientAbort = new AbortController()
      const abortOnClose = () => clientAbort.abort()
      reply.raw.once('close', abortOnClose)
      try {
        const plan = await planQuestion(
          db,
          app.deps.cfg,
          input.question,
          input.mode,
          clientAbort.signal
        )
        if (clientAbort.signal.aborted) return reply
        mode = plan.mode
        sse(reply.raw, 'route', {
          mode,
          planner: plan.source,
          intent: plan.intent,
          subQueryCount: plan.subQueries.length
        })
        sse(reply.raw, 'status', { stage: 'retrieving', message: '正在权限范围内检索证据' })

        const retrievals: RetrieveResponse[] = []
        const seenQueries = new Set<string>()
        const hardMaxRounds = input.mode === 'fast'
          ? 1
          : app.deps.cfg.agenticMaxRounds
        let pendingQueries = plan.subQueries
        let queriesUsed = 0
        let roundsUsed = 0
        let assessment: AgenticAssessment = {
          sufficient: false,
          confidence: 0,
          reason: 'none',
          coveredFacts: [],
          missingFacts: [],
          followUpQueries: [],
          source: 'deterministic'
        }

        for (let round = 0; round < hardMaxRounds; round += 1) {
          const remaining = app.deps.cfg.agenticMaxQueries - queriesUsed
          const batch = pendingQueries
            .map((query) => query.replace(/\s+/g, ' ').trim())
            .filter((query) => {
              const key = query.toLowerCase()
              if (!query || seenQueries.has(key)) return false
              seenQueries.add(key)
              return true
            })
            .slice(0, Math.max(0, remaining))
          if (batch.length === 0) break
          roundsUsed = round + 1
          queriesUsed += batch.length
          const roundResults = await Promise.all(batch.map((query) =>
            retriever.retrieve(claims.sub, {
              query,
              limit: mode === 'deep' ? 10 : 8,
              // 规划器已经产生独立子查询，不再让 Retriever 做第二次规则拆分。
              multiHop: false,
              tokenBudget: mode === 'deep' ? 7000 : 6000,
              scopes: input.scopeKinds,
              scopeIds: input.scopeIds,
              filters: input.filters
            })
          ))
          retrievals.push(...roundResults)
          const merged = mergeRetrievals(retrievals)
          sse(reply.raw, 'status', {
            stage: 'assessing',
            message: '正在检查必要事实是否都有直接证据',
            round: round + 1
          })
          assessment = await assessEvidence(
            db,
            app.deps.cfg,
            input.question,
            plan,
            merged.chunks,
            clientAbort.signal
          )
          if (clientAbort.signal.aborted) return reply
          if (
            assessment.sufficient ||
            round + 1 >= hardMaxRounds ||
            queriesUsed >= app.deps.cfg.agenticMaxQueries
          ) break

          pendingQueries = assessment.followUpQueries.length > 0
            ? assessment.followUpQueries
            : fallbackFollowUpQueries(
                input.question,
                merged.chunks,
                assessment.missingFacts,
                round + 1
              )
          // auto 的初始 fast 路径发现证据缺口后自动升级，显式 fast 则严格
          // 遵守低延迟约定，不偷偷增加轮次。
          if (mode === 'fast' && input.mode === 'auto') {
            mode = 'deep'
            sse(reply.raw, 'route', { mode, planner: 'evidence_gap', intent: plan.intent })
          }
          sse(reply.raw, 'status', {
            stage: 'rewriting',
            message: '证据仍有缺口，正在生成精准补检问题',
            round: round + 2
          })
        }
        const retrieved = mergeRetrievals(retrievals)
        if (clientAbort.signal.aborted) return reply

        const citations = citationsFrom(retrieved.chunks)
        sse(reply.raw, 'status', { stage: 'retrieved', message: '已完成权限内证据检索' })
        for (const citation of citations) sse(reply.raw, 'citation', citation)

        let final: AskFinal
        if (assessment.reason === 'none' || citations.length === 0) {
          final = {
            answer: '当前授权范围内没有找到足够支撑答案的证据。',
            claims: [],
            citations: [],
            confidence: 0,
            insufficient: true,
            suggestedPeople: retrieved.suggestAsk ?? [],
            traceId,
            mode,
            verification: 'insufficient'
          }
        } else if (assessment.reason === 'stale_only') {
          final = {
            answer: '只找到了可能已过期的易变资料，不能据此给出确定答案，请联系文档负责人确认。',
            claims: [],
            citations,
            confidence: 0.2,
            insufficient: true,
            suggestedPeople: retrieved.suggestAsk ?? [],
            traceId,
            mode,
            verification: 'stale_only'
          }
        } else if (!assessment.sufficient) {
          final = {
            answer: '找到了一些相关资料，但与问题的相关性和证据覆盖不足，不能给出可验证答案。',
            claims: [],
            citations,
            confidence: assessment.confidence,
            insufficient: true,
            suggestedPeople: retrieved.suggestAsk ?? [],
            traceId,
            mode,
            verification: 'insufficient'
          }
        } else {
          sse(reply.raw, 'status', { stage: 'generating', message: '正在生成原子化、有引用的事实' })
          // 过期资料可以展示给用户解释“为什么拒答”，但绝不能进入生成或
          // claim 校验上下文。先分配 citation id 再过滤，保持 UI id 稳定。
          const evidence = evidenceFromChunks(retrieved.chunks).filter((item) => !item.stale)
          let generated = await generateAnswerDraft(
            db,
            app.deps.cfg,
            input.question,
            plan,
            evidence,
            clientAbort.signal
          )
          if (clientAbort.signal.aborted) return reply
          if (generated?.insufficient) {
            final = {
              answer: '模型判定当前证据无法支撑可验证答案。',
              claims: [], citations, confidence: Math.min(assessment.confidence, 0.45),
              insufficient: true, suggestedPeople: retrieved.suggestAsk ?? [],
              traceId, mode, verification: 'insufficient'
            }
          } else if (generated) {
            sse(reply.raw, 'status', { stage: 'verifying', message: '正在逐条核对数字、条件、否定和引用' })
            let validation = await verifyClaims(
              db,
              app.deps.cfg,
              input.question,
              plan.requiredFacts,
              generated.claims,
              evidence,
              clientAbort.signal
            )
            if (clientAbort.signal.aborted) return reply
            if (!validation.valid) {
              sse(reply.raw, 'status', { stage: 'repairing', message: '事实校验未通过，正在受约束修复一次' })
              const repairIssues = validation.issues.map((issue) => ({
                claimIndex: issue.claimIndex,
                reason: `${issue.reason}; 原 claim: ${generated?.claims[issue.claimIndex]?.text ?? '(整体错误)'}`
              }))
              const repaired = await generateAnswerDraft(
                db,
                app.deps.cfg,
                input.question,
                plan,
                evidence,
                clientAbort.signal,
                repairIssues
              )
              if (clientAbort.signal.aborted) return reply
              if (repaired && !repaired.insufficient) {
                const repairedValidation = await verifyClaims(
                  db,
                  app.deps.cfg,
                  input.question,
                  plan.requiredFacts,
                  repaired.claims,
                  evidence,
                  clientAbort.signal
                )
                if (repairedValidation.valid) {
                  generated = repaired
                  validation = repairedValidation
                }
              }
            }
            final = validation.valid
              ? {
                  answer: renderClaims(generated.claims),
                  claims: generated.claims.map((claim) => ({ ...claim, verification: 'supported' as const })),
                  citations,
                  confidence: Math.max(0.7, assessment.confidence), insufficient: false,
                  suggestedPeople: [], traceId, mode, verification: 'supported'
                }
              : (() => {
                  // 生成失败不等于证据不可用：退回逐字原文比返回一个未经
                  // 验证的流畅答案更安全，也比直接让用户空手而归更实用。
                  const grounded = extractiveAnswer(
                    citations.filter((citation) => !citation.stale),
                    retrieved.chunks.filter((chunk) => !chunk.stale)
                  )
                  return {
                    ...grounded, citations, confidence: Math.min(assessment.confidence, 0.65),
                    insufficient: false, suggestedPeople: [], traceId, mode,
                    verification: 'extractive_fallback' as const
                  }
                })()
          } else {
            // 未配置/暂时无法使用生成模型时，只返回原文抽取；
            // 这些 claim 与 quote 字面相同，因此不会引入新事实。
            const grounded = extractiveAnswer(
              citations.filter((citation) => !citation.stale),
              retrieved.chunks.filter((chunk) => !chunk.stale)
            )
            final = {
              ...grounded, citations, confidence: assessment.confidence,
              insufficient: false, suggestedPeople: [], traceId, mode,
              verification: 'extractive_fallback'
            }
          }
        }

        final.agentic = {
          planner: plan.source,
          assessor: assessment.source,
          rounds: roundsUsed,
          queries: queriesUsed
        }
        final.qaEventId = qaId
        db.prepare(
          `INSERT INTO qa_events
             (id, user_id, question, answered, cited_chunks, top_score,
              latency_ms, route, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(
          qaId,
          claims.sub,
          input.question,
          final.insufficient ? 0 : 1,
          JSON.stringify(final.citations.map((citation) => citation.chunkId)),
          retrieved.chunks[0]?.score ?? null,
          Date.now() - startedAt,
          mode === 'deep' ? 'agentic' : 'fast',
          Date.now()
        )
        app.audit(req, 'knowledge_ask', traceId, {
          mode,
          insufficient: final.insufficient,
          citations: final.citations.length,
          planner: plan.source,
          assessor: assessment.source,
          rounds: roundsUsed,
          queries: queriesUsed,
          qaId,
          latencyMs: Date.now() - startedAt
        })

        for (const text of answerDeltas(final.answer)) sse(reply.raw, 'delta', { text })
        sse(reply.raw, 'verification', {
          status: final.verification,
          confidence: final.confidence,
          insufficient: final.insufficient
        })
        sse(reply.raw, 'final', final)
      } catch (error) {
        if (!clientAbort.signal.aborted) {
          sse(reply.raw, 'error', {
            code: 'KNOWLEDGE_ASK_FAILED',
            message: error instanceof Error ? error.message : String(error),
            traceId
          })
        }
      } finally {
        reply.raw.off('close', abortOnClose)
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end()
      }
      return reply
    }
  )
}
