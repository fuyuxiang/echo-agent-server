import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AuthedRequest } from '../auth/jwt.js'
import {
  assessEvidence,
  fallbackFollowUpQueries,
  planQuestion,
  type AgenticAssessment
} from '../kb/agentic.js'
import type { RetrievedChunk, RetrieveResponse } from '../kb/retrieve/index.js'
import { estimateTokens } from '../kb/retrieve/text.js'
import { fail, ok } from '../reply.js'

const ContextSchema = z.object({
  task: z.string().min(1).max(8000),
  mode: z.enum(['fast', 'deep', 'auto']).default('auto'),
  workspaceRef: z.string().max(1000).optional(),
  taskId: z.string().max(256).optional(),
  sessionId: z.string().max(256).optional(),
  scopeKinds: z.array(z.enum(['personal', 'team', 'org'])).max(3).optional(),
  scopeIds: z.array(z.string().max(256)).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(24).default(12),
  tokenBudget: z.coerce.number().int().min(500).max(20_000).default(8_000),
  filters: z.object({
    tags: z.array(z.string().min(1).max(128)).max(50).optional(),
    sourceTypes: z.array(z.string().min(1).max(64)).max(30).optional()
  }).optional()
})

const FeedbackSchema = z.object({
  traceId: z.string().uuid(),
  action: z.enum(['apply', 'feedback']),
  outcome: z.enum(['unknown', 'helpful', 'unhelpful', 'applied', 'failed']),
  taskId: z.string().max(256).optional(),
  sessionId: z.string().max(256).optional(),
  workspaceRef: z.string().max(1000).optional(),
  resultIds: z.array(z.string().max(256)).max(100).optional(),
  citationIds: z.array(z.string().max(256)).max(100).optional(),
  feedback: z.string().max(2000).optional()
})

function mergeResults(
  results: RetrieveResponse[],
  limit: number,
  tokenBudget: number,
  workspaceRef?: string
): RetrieveResponse {
  const byChunk = new Map<string, RetrievedChunk>()
  const byMemory = new Map<string, RetrieveResponse['memories'][number]>()
  for (const result of results) {
    for (const chunk of result.chunks) {
      const prior = byChunk.get(chunk.chunkId)
      if (!prior || chunk.score > prior.score) byChunk.set(chunk.chunkId, chunk)
    }
    for (const memory of result.memories) {
      const prior = byMemory.get(memory.id)
      if (!prior || memory.relevanceScore > prior.relevanceScore) {
        byMemory.set(memory.id, memory)
      }
    }
  }
  const chunks: RetrievedChunk[] = []
  const perDocument = new Map<string, number>()
  let usedTokens = 0
  for (const chunk of [...byChunk.values()].sort((a, b) =>
    Number(a.stale) - Number(b.stale) || b.score - a.score
  )) {
    if ((perDocument.get(chunk.docId) ?? 0) >= 4) continue
    const cost = estimateTokens(chunk.text)
    if (chunks.length > 0 && usedTokens + cost > tokenBudget) continue
    chunks.push(chunk)
    usedTokens += cost
    perDocument.set(chunk.docId, (perDocument.get(chunk.docId) ?? 0) + 1)
    if (chunks.length >= limit) break
  }
  const people = new Map<string, NonNullable<RetrieveResponse['suggestAsk']>[number]>()
  for (const person of results.flatMap((result) => result.suggestAsk ?? [])) {
    if (!people.has(person.userId)) people.set(person.userId, person)
  }
  return {
    chunks,
    memories: [...byMemory.values()]
      .sort((a, b) => {
        const trust = { reported: 0, reviewed: 1, verified: 2 }
        const contextualScore = (memory: typeof a): number =>
          memory.relevanceScore
          + (workspaceRef && memory.workspaceRef === workspaceRef ? 0.12 : 0)
          + trust[memory.trust] * 0.02
          + memory.confidence * 0.04
        return Number(a.stale) - Number(b.stale)
          || contextualScore(b) - contextualScore(a)
      })
      .slice(0, 12),
    suggestAsk: [...people.values()].slice(0, 3),
    diagnostics: {
      bm25Hits: results.reduce((sum, item) => sum + item.diagnostics.bm25Hits, 0),
      vecHits: results.reduce((sum, item) => sum + item.diagnostics.vecHits, 0),
      fusedCandidates: results.reduce((sum, item) => sum + item.diagnostics.fusedCandidates, 0),
      rerankMs: results.reduce((sum, item) => sum + item.diagnostics.rerankMs, 0),
      rerankSkipped: results.some((item) => item.diagnostics.rerankSkipped),
      totalMs: results.reduce((sum, item) => sum + item.diagnostics.totalMs, 0)
    }
  }
}

/**
 * A reviewed experience is first-class task evidence, not decorative metadata.
 * Convert it only for the coverage assessor; the public response keeps the
 * richer memory shape and does not pretend that a memory is a document chunk.
 */
function evidenceForAssessment(result: RetrieveResponse): RetrievedChunk[] {
  const memoryEvidence: RetrievedChunk[] = result.memories.map((memory) => ({
    chunkId: `memory:${memory.id}`,
    docId: `memory:${memory.id}`,
    docTitle: `${memory.scopeName} / ${memory.kind}`,
    text: [memory.content, memory.rationale, memory.outcome].filter(Boolean).join('\n'),
    score: memory.confidence,
    scopeKind: memory.scopeKind,
    modality: 'text',
    sourceType: 'memory',
    source: memory.scopeKind === 'personal' ? 'L2' : 'L3',
    citation: {
      page: null,
      heading: memory.kind,
      startMs: null,
      endMs: null,
      openUrl: ''
    },
    owner: null,
    stale: memory.stale,
    updatedAt: memory.updatedAt
  }))
  return [...result.chunks, ...memoryEvidence]
}

export function registerKnowledgeContextRoutes(app: FastifyInstance): void {
  const { db, retriever } = app.deps

  app.post('/api/v1/knowledge/context', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = ContextSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message}`))
    }
    const input = parsed.data
    const claims = (req as AuthedRequest).claims
    const traceId = randomUUID()
    const startedAt = Date.now()
    const plan = await planQuestion(db, app.deps.cfg, input.task, input.mode)
    const seen = new Set<string>()
    const retrievals: RetrieveResponse[] = []
    let pending = plan.subQueries
    let rounds = 0
    let queries = 0
    let assessment: AgenticAssessment = {
      sufficient: false,
      confidence: 0,
      reason: 'none',
      coveredFacts: [],
      missingFacts: plan.requiredFacts,
      followUpQueries: [],
      source: 'deterministic'
    }
    const maxRounds = input.mode === 'fast' ? 1 : app.deps.cfg.agenticMaxRounds

    for (let round = 0; round < maxRounds; round += 1) {
      const remaining = app.deps.cfg.agenticMaxQueries - queries
      const batch = pending
        .map((query) => query.replace(/\s+/g, ' ').trim())
        .filter((query) => {
          const key = query.toLowerCase()
          if (!query || seen.has(key)) return false
          seen.add(key)
          return true
        })
        .slice(0, Math.max(0, remaining))
      if (batch.length === 0) break
      rounds = round + 1
      queries += batch.length
      retrievals.push(...await Promise.all(batch.map((query) => retriever.retrieve(claims.sub, {
        query,
        limit: Math.min(input.limit, plan.mode === 'deep' ? 12 : 8),
        tokenBudget: input.tokenBudget,
        scopes: input.scopeKinds,
        scopeIds: input.scopeIds,
        workspaceRef: input.workspaceRef,
        filters: input.filters,
        multiHop: false
      }))))
      const merged = mergeResults(retrievals, input.limit, input.tokenBudget, input.workspaceRef)
      assessment = await assessEvidence(
        db,
        app.deps.cfg,
        input.task,
        plan,
        evidenceForAssessment(merged)
      )
      if (assessment.sufficient || queries >= app.deps.cfg.agenticMaxQueries) break
      pending = assessment.followUpQueries.length > 0
        ? assessment.followUpQueries
        : fallbackFollowUpQueries(input.task, merged.chunks, assessment.missingFacts, round + 1)
    }

    const result = mergeResults(retrievals, input.limit, input.tokenBudget, input.workspaceRef)
    const memories = result.memories
    const context = {
      traceId,
      sufficient: assessment.sufficient,
      confidence: assessment.confidence,
      missingFacts: assessment.missingFacts,
      plan: {
        mode: plan.mode,
        intent: plan.intent,
        requiredFacts: plan.requiredFacts,
        queries: [...seen],
        planner: plan.source,
        assessor: assessment.source,
        rounds
      },
      evidence: result.chunks,
      memories,
      runbooks: memories.filter((memory) => memory.kind === 'howto'),
      gotchas: memories.filter((memory) => memory.kind === 'pitfall'),
      rules: memories.filter((memory) => memory.kind === 'decision' || memory.kind === 'convention'),
      suggestedPeople: result.suggestAsk ?? [],
      diagnostics: { ...result.diagnostics, latencyMs: Date.now() - startedAt }
    }

    db.prepare(
      `INSERT INTO knowledge_usage_events
         (id, trace_id, user_id, action, query, task_id, session_id, workspace_ref,
          result_ids, citation_ids, outcome, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(), traceId, claims.sub, 'context', input.task,
      input.taskId ?? null, input.sessionId ?? null, input.workspaceRef ?? null,
      JSON.stringify(memories.map((memory) => memory.id)),
      JSON.stringify(result.chunks.map((chunk) => chunk.chunkId)),
      'unknown', Date.now()
    )
    app.audit(req, 'knowledge_context', traceId, {
      sufficient: assessment.sufficient,
      memories: memories.length,
      citations: result.chunks.length,
      rounds,
      queries,
      latencyMs: Date.now() - startedAt
    })
    return reply.send(ok(context))
  })

  app.post('/api/v1/knowledge/events', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = FeedbackSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message}`))
    }
    const input = parsed.data
    const claims = (req as AuthedRequest).claims
    const ownedTrace = db.prepare(
      `SELECT result_ids AS resultIds, citation_ids AS citationIds
         FROM knowledge_usage_events
        WHERE trace_id=? AND user_id=? AND action='context'
        ORDER BY created_at LIMIT 1`
    ).get(input.traceId, claims.sub) as
      | { resultIds: string | null; citationIds: string | null }
      | undefined
    if (!ownedTrace) return reply.code(404).send(fail(4041, '上下文追踪记录不存在'))
    const servedResults = parseIds(ownedTrace.resultIds)
    const servedCitations = parseIds(ownedTrace.citationIds)
    const resultIds = input.resultIds ?? servedResults
    const citationIds = input.citationIds ?? servedCitations
    if (
      resultIds.some((id) => !servedResults.includes(id))
      || citationIds.some((id) => !servedCitations.includes(id))
    ) {
      return reply.code(400).send(fail(4002, '反馈只能关联本次上下文实际返回的结果'))
    }
    const id = randomUUID()
    const now = Date.now()
    db.transaction(() => {
      db.prepare(
        `INSERT INTO knowledge_usage_events
           (id, trace_id, user_id, action, task_id, session_id, workspace_ref,
            result_ids, citation_ids, outcome, feedback, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id, input.traceId, claims.sub, input.action, input.taskId ?? null,
        input.sessionId ?? null, input.workspaceRef ?? null,
        JSON.stringify(resultIds), JSON.stringify(citationIds),
        input.outcome, input.feedback ?? null, now
      )
      const insert = db.prepare(
        `INSERT INTO knowledge_result_feedback
           (id, trace_id, user_id, result_id, result_kind, outcome, created_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      for (const resultId of resultIds) {
        insert.run(randomUUID(), input.traceId, claims.sub, resultId, 'memory', input.outcome, now)
      }
      for (const citationId of citationIds) {
        insert.run(randomUUID(), input.traceId, claims.sub, citationId, 'citation', input.outcome, now)
      }
    })()
    app.audit(req, 'knowledge_feedback', input.traceId, {
      action: input.action,
      outcome: input.outcome
    })
    return reply.send(ok({ eventId: id }))
  })
}

function parseIds(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : []
  } catch {
    return []
  }
}
