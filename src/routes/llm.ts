import { once } from 'node:events'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { decryptSecret, deriveKey } from '../crypto.js'
import type { AuthedRequest } from '../auth/jwt.js'

/**
 * OpenAI-compatible chat proxy.
 *
 * `/api/v1/llm/v1/chat/completions` is the canonical endpoint consumed by
 * echo-agent/OpenAI SDK and therefore returns upstream JSON/SSE unchanged.
 * `/api/v1/llm/chat` remains as an envelope-wrapped compatibility route.
 */

const OpenAiMessage = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool'])
  })
  .catchall(z.unknown())

const ChatBody = z
  .object({
    model: z.string().optional(),
    messages: z.array(OpenAiMessage).min(1),
    stream: z.boolean().optional().default(false)
  })
  .catchall(z.unknown())

interface ModelConfigRow {
  chat_provider: string
  chat_model: string
  chat_base_url: string | null
  chat_key_enc: string | null
}

function pickModelConfig(db: AppDeps['db']): ModelConfigRow | undefined {
  return db
    .prepare(
      `SELECT chat_provider, chat_model, chat_base_url, chat_key_enc
         FROM model_configs WHERE id = 'default'`
    )
    .get() as ModelConfigRow | undefined
}

interface AppDeps {
  db: import('../db/index.js').DB
  cfg: import('../config.js').Config
}

function proxyError(
  reply: FastifyReply,
  openAiCompatible: boolean,
  status: number,
  code: number,
  message: string
): FastifyReply {
  if (!openAiCompatible) return reply.code(status).send(fail(code, message))
  return reply.code(status).send({
    error: { message, type: 'echo_proxy_error', code: String(code) }
  })
}

export function registerLlmRoutes(app: FastifyInstance): void {
  const { db, cfg } = app.deps as unknown as AppDeps
  const master = deriveKey(cfg.masterKey)

  const handler =
    (openAiCompatible: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ChatBody.safeParse(req.body ?? {})
      if (!parsed.success) {
        return proxyError(
          reply,
          openAiCompatible,
          400,
          4001,
          `参数错误: ${parsed.error.issues[0]?.message ?? '未知'}`
        )
      }

      const m = pickModelConfig(db)
      if (!m?.chat_key_enc) {
        return proxyError(reply, openAiCompatible, 503, 5031, '服务端尚未配置模型 Key')
      }

      let key: string
      try {
        key = decryptSecret(m.chat_key_enc, master)
      } catch {
        return proxyError(reply, openAiCompatible, 503, 5032, '服务端模型 Key 损坏')
      }

      const baseUrl = (m.chat_base_url ?? 'https://api.openai.com/v1').replace(/\/$/, '')
      const target = `${baseUrl}/chat/completions`
      const { extra, ...incoming } = parsed.data as typeof parsed.data & {
        extra?: Record<string, unknown>
      }
      const upstreamBody = {
        ...incoming,
        ...(extra ?? {}),
        // Server-side configuration is authoritative. This prevents a caller
        // from selecting an unapproved or unexpectedly expensive model.
        model: m.chat_model,
        stream: parsed.data.stream
      }

      app.audit(req, 'llm_chat', undefined, {
        model: upstreamBody.model,
        messages: parsed.data.messages.length,
        stream: parsed.data.stream
      })

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 120_000)
      const abortOnDisconnect = (): void => {
        if (!reply.raw.writableEnded) ctrl.abort()
      }
      reply.raw.once('close', abortOnDisconnect)

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
        reply.raw.off('close', abortOnDisconnect)
        const message = ctrl.signal.aborted
          ? '上游请求超时或客户端已断开'
          : `上游不可达: ${(e as Error).message}`
        return proxyError(reply, openAiCompatible, 502, 5021, message)
      }

      if (!upstream.ok) {
        const bodyText = await upstream.text().catch(() => '')
        clearTimeout(timer)
        reply.raw.off('close', abortOnDisconnect)
        if (openAiCompatible) {
          try {
            return reply.code(upstream.status).send(JSON.parse(bodyText))
          } catch {
            return proxyError(
              reply,
              true,
              upstream.status,
              upstream.status,
              bodyText.slice(0, 500)
            )
          }
        }
        return reply.code(upstream.status).send(fail(upstream.status, bodyText.slice(0, 500)))
      }

      if (!parsed.data.stream) {
        const body = (await upstream.json()) as unknown
        clearTimeout(timer)
        reply.raw.off('close', abortOnDisconnect)
        return reply.send(openAiCompatible ? body : ok(body))
      }

      if (!upstream.body) {
        clearTimeout(timer)
        reply.raw.off('close', abortOnDisconnect)
        return proxyError(reply, openAiCompatible, 502, 5022, '上游无响应体')
      }

      reply.hijack()
      reply.raw.statusCode = upstream.status
      reply.raw.setHeader(
        'content-type',
        upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8'
      )
      reply.raw.setHeader('cache-control', 'no-cache')
      reply.raw.setHeader('x-accel-buffering', 'no')
      const reader = upstream.body.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (!reply.raw.write(Buffer.from(value))) await once(reply.raw, 'drain')
        }
      } catch (e) {
        if (!ctrl.signal.aborted) throw e
      } finally {
        clearTimeout(timer)
        reply.raw.off('close', abortOnDisconnect)
        reader.releaseLock()
        if (!reply.raw.writableEnded) reply.raw.end()
      }
      return reply
    }

  const routeOptions = {
    preHandler: app.authenticate,
    config: {
      rateLimit: {
        max: cfg.rateLimitLlmPerMin > 0 ? cfg.rateLimitLlmPerMin : 1000,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => {
          const claims = (req as AuthedRequest).claims
          return claims?.sub ?? req.ip
        }
      }
    }
  }

  app.post('/api/v1/llm/chat', routeOptions, handler(false))
  app.post('/api/v1/llm/v1/chat/completions', routeOptions, handler(true))

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
