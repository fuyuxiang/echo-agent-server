import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { decryptSecret, deriveKey } from '../crypto.js'
import type { AuthedRequest } from '../auth/jwt.js'

/**
 * LLM 代理。
 *
 * 方案 §4.8:模型 Key 仅存在服务端,推理由 server 代理。客户端只拿到
 * model-config 中的 provider/model/dim,不接触明文 Key。
 *
 * - 入参与 OpenAI /chat/completions 兼容;
 * - 出参走 SSE,与 OpenAI streaming 一致;
 * - rate-limit 单独按用户 sub 计数(方案 5.6:20/min);
 * - 成本记账:在 audit 表里写入调用计数与模型名,token 用量从响应解析。
 *
 * 仅在 model_configs.chat_key_enc 已配置时启用;否则 503,让客户端回退到
 * 用户本地 Key。
 */

const ChatBody = z.object({
  model: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string().min(1).max(64_000)
      })
    )
    .min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().int().positive().max(32_000).optional(),
  // 透传额外参数(频率惩罚、停止词等),服务端不解析,直接转发。
  extra: z.record(z.string(), z.unknown()).optional()
})

interface ModelConfigRow {
  chat_provider: string
  chat_model: string
  chat_base_url: string | null
  chat_key_enc: string | null
}

function pickModelConfig(db: AppDeps['db']): ModelConfigRow | undefined {
  return db
    .prepare(
      `SELECT chat_provider AS chatProvider, chat_model AS chatModel,
              chat_base_url AS chatBaseUrl, chat_key_enc AS chatKeyEnc
         FROM model_configs WHERE id = 'default'`
    )
    .get() as ModelConfigRow | undefined
}

interface AppDeps {
  db: import('../db/index.js').DB
  cfg: import('../config.js').Config
}

export function registerLlmRoutes(app: FastifyInstance): void {
  const { db, cfg } = app.deps as unknown as AppDeps
  const master = deriveKey(cfg.masterKey)

  app.post(
    '/api/v1/llm/chat',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: cfg.rateLimitLlmPerMin > 0 ? cfg.rateLimitLlmPerMin : 1000,
          timeWindow: '1 minute',
          keyGenerator: (req) => {
            const claims = (req as AuthedRequest).claims
            return claims?.sub ?? req.ip
          }
        }
      }
    },
    async (req, reply) => {
      const parsed = ChatBody.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply
          .code(400)
          .send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message ?? '未知'}`))
      }

      const m = pickModelConfig(db)
      if (!m?.chat_key_enc) {
        return reply.code(503).send(fail(5031, '服务端尚未配置模型 Key'))
      }

      let key: string
      try {
        key = decryptSecret(m.chat_key_enc, master)
      } catch {
        return reply.code(503).send(fail(5032, '服务端模型 Key 损坏'))
      }

      const baseUrl = (m.chat_base_url ?? 'https://api.openai.com/v1').replace(/\/$/, '')
      const target = `${baseUrl}/chat/completions`

      const upstreamBody = {
        model: parsed.data.model ?? m.chat_model,
        messages: parsed.data.messages,
        ...(parsed.data.temperature !== undefined ? { temperature: parsed.data.temperature } : {}),
        ...(parsed.data.top_p !== undefined ? { top_p: parsed.data.top_p } : {}),
        ...(parsed.data.max_tokens !== undefined ? { max_tokens: parsed.data.max_tokens } : {}),
        stream: parsed.data.stream,
        ...(parsed.data.extra ?? {})
      }

      app.audit(req, 'llm_chat', undefined, {
        model: upstreamBody.model,
        messages: parsed.data.messages.length,
        stream: parsed.data.stream
      })

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 60_000)
      let upstream: Response
      try {
        upstream = await fetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`
          },
          body: JSON.stringify(upstreamBody),
          signal: ctrl.signal
        })
      } catch (e) {
        clearTimeout(timer)
        return reply.code(502).send(fail(5021, `上游不可达: ${(e as Error).message}`))
      }

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '')
        clearTimeout(timer)
        return reply.code(upstream.status).send(fail(upstream.status, text.slice(0, 500)))
      }

      if (!parsed.data.stream) {
        const body = (await upstream.json()) as unknown
        clearTimeout(timer)
        return reply.send(ok(body))
      }

      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8')
      reply.raw.setHeader('cache-control', 'no-cache')
      reply.raw.setHeader('x-accel-buffering', 'no')
      if (!upstream.body) {
        clearTimeout(timer)
        return reply.code(502).send(fail(5022, '上游无响应体'))
      }
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          reply.raw.write(decoder.decode(value))
        }
      } finally {
        clearTimeout(timer)
        reader.releaseLock()
        reply.raw.end()
      }
      reply.hijack()
    }
  )

  app.get('/api/v1/llm/health', { preHandler: app.authenticate }, async (_req, reply) => {
    const m = pickModelConfig(db)
    return reply.send(
      ok({
        configured: !!m?.chat_key_enc,
        provider: m?.chat_provider ?? null,
        model: m?.chat_model ?? null
      })
    )
  })
}
