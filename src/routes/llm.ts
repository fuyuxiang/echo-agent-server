import { authenticateKey } from '../gateway/keys.js'
import { meteredFetch, usageContext, settings, QuotaError } from '../gateway/usage.js'
import { once } from 'node:events'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import type { AuthedRequest } from '../auth/jwt.js'
import { resolveChatConfig } from '../models/chat-config.js'

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

  const handler =
    (openAiCompatible: boolean, protocol = 'chat') => async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = (protocol === 'chat' ? ChatBody : z.object({stream:z.boolean().optional().default(false)}).catchall(z.unknown())).safeParse(req.body ?? {})
      if (!parsed.success) {
        return proxyError(
          reply,
          openAiCompatible,
          400,
          4001,
          `参数错误: ${parsed.error.issues[0]?.message ?? '未知'}`
        )
      }

      const m = resolveChatConfig(db, cfg)
      if (m.credentialError) {
        return proxyError(reply, openAiCompatible, 503, 5032, '服务端模型 Key 损坏')
      }
      if (!m.configured || !m.key || !m.model) {
        return proxyError(reply, openAiCompatible, 503, 5031, '服务端尚未完整配置聊天模型')
      }

      const policy = settings(db)
      if (!JSON.parse(policy.protocols).includes(protocol)) return proxyError(reply, openAiCompatible, 403, 4031, '该模型协议尚未启用')
      const paths:Record<string,string>={chat:'chat/completions',responses:'responses',anthropic:'messages',images:'images/generations',speech:'audio/speech'}
      if(['images','speech'].includes(protocol)){m.model=JSON.parse(policy.models_json)[protocol]??null;if(!m.model)return proxyError(reply,openAiCompatible,503,5031,'尚未配置此能力的上游模型')}
      const target = `${m.baseUrl}/${paths[protocol]}`
      const { extra, ...incoming } = parsed.data as typeof parsed.data & {
        extra?: Record<string, unknown>
      }
      const upstreamBody: Record<string, any> = {
        ...incoming,
        ...(extra ?? {}),
        // Server-side configuration is authoritative. This prevents a caller
        // from selecting an unapproved or unexpectedly expensive model.
        model: m.model,
        stream: parsed.data.stream
      }

      const requested = Number(upstreamBody.max_completion_tokens ?? upstreamBody.max_output_tokens ?? upstreamBody.max_tokens ?? policy.max_output_tokens)
      if (protocol === 'chat' || protocol === 'anthropic') {
        const field = protocol === 'chat' && upstreamBody.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens'
        delete upstreamBody.max_completion_tokens; delete upstreamBody.max_tokens
        upstreamBody[field] = Math.min(policy.max_output_tokens, Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : policy.max_output_tokens)
      } else if (protocol === 'responses') upstreamBody.max_output_tokens = Math.min(policy.max_output_tokens, Number.isFinite(requested)&&requested>0?Math.floor(requested):policy.max_output_tokens)
      if(['images','speech'].includes(protocol))delete upstreamBody.stream
      if (protocol === 'chat' && parsed.data.stream) upstreamBody.stream_options = {...(upstreamBody.stream_options ?? {}),include_usage:true}
      app.audit(req, 'llm_chat', undefined, {
        model: upstreamBody.model,
        messages: Array.isArray(parsed.data.messages) ? parsed.data.messages.length : 0,
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
        upstream = await meteredFetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${m.key}`,
            ...(protocol==='anthropic'?{'x-api-key':m.key!,'anthropic-version':'2023-06-01'}:{})
          },
          body: JSON.stringify(upstreamBody),
          signal: ctrl.signal
        }, {source:['chat','responses','anthropic'].includes(protocol)?'desktop_chat':protocol,model:m.model,protocol,units:protocol==='images'?{requestedImages:Number(upstreamBody.n??1)}:protocol==='speech'?{inputCharacters:Array.from(String(upstreamBody.input??upstreamBody.text??'')).length}:undefined})
      } catch (e) {
        clearTimeout(timer)
        reply.raw.off('close', abortOnDisconnect)
        if (e instanceof QuotaError) return proxyError(reply,openAiCompatible,429,4291,e.message)
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

      if (!parsed.data.stream && !(upstream.headers.get('content-type')??'').includes('text/event-stream')) {
        try {
          const type = upstream.headers.get('content-type')??'application/json'
          if (protocol==='speech' && !type.includes('json')) return reply.header('content-type',type).send(Buffer.from(await upstream.arrayBuffer()))
          const body = await upstream.json()
          return reply.send(openAiCompatible ? body : ok(body))
        } catch { return proxyError(reply,openAiCompatible,502,5022,'上游响应格式不兼容') }
        finally { clearTimeout(timer); reply.raw.off('close',abortOnDisconnect) }
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
      } catch {
        ctrl.abort()
      } finally {
        clearTimeout(timer)
        reply.raw.off('close', abortOnDisconnect)
        reader.releaseLock()
        if (!reply.raw.writableEnded) reply.raw.end()
      }
      return reply
    }

  const authenticate = async (req:FastifyRequest, reply:FastifyReply):Promise<void> => {
    const token=(req.headers.authorization?.replace(/^Bearer\s+/i,'') ?? String(req.headers['x-api-key']??''))
    if (/^[A-F0-9]{32}$/.test(token)) {
      const key=authenticateKey(db,token)
      if(!key) {reply.code(401).send({error:{message:'API Key 无效、已撤销或账号已停用',type:'authentication_error'}});return}
      ;(req as AuthedRequest).claims={sub:key.userId,role:key.role,tv:key.tv,device:key.deviceId??undefined}
      const ctx=usageContext.getStore();if(ctx){ctx.userId=key.userId;ctx.keyId=key.id;ctx.deviceId=key.deviceId??undefined}
    } else await app.authenticate(req,reply)
  }
  const routeOptions = {preHandler:authenticate,config:{rateLimit:false as const}}
  app.post('/api/v1/llm/chat', routeOptions, handler(false))
  app.post('/api/v1/llm/v1/chat/completions', routeOptions, handler(true))
  app.post('/api/v1/llm/v1/responses',routeOptions,handler(true,'responses'))
  app.post('/api/v1/llm/v1/messages',routeOptions,handler(true,'anthropic'))
  app.post('/api/v1/llm/v1/images/generations',routeOptions,handler(true,'images'))
  app.post('/api/v1/llm/v1/audio/speech',routeOptions,handler(true,'speech'))
  app.post('/api/v1/llm/v1/audio/transcriptions',routeOptions,async(req,reply)=>{
    const m=resolveChatConfig(db,app.deps.cfg),policy=settings(db),model=JSON.parse(policy.models_json).transcription
    if(!JSON.parse(policy.protocols).includes('transcription')||!model||!m.key)return proxyError(reply,true,503,5031,'音频转写尚未启用或配置')
    const form=new FormData();let hasFile=false;let bytes=0
    for await(const part of req.parts()){if(part.type==='file'){const data=await part.toBuffer();if(part.file.truncated)return proxyError(reply,true,413,4131,'文件超过上限');bytes=data.length;form.append('file',new Blob([new Uint8Array(data)],{type:part.mimetype}),part.filename);hasFile=true}else if(['language','prompt','response_format','temperature'].includes(part.fieldname))form.append(part.fieldname,String(part.value))}
    if(!hasFile)return proxyError(reply,true,400,4001,'缺少音频文件')
    form.append('model',model)
    try{const upstream=await meteredFetch(`${m.baseUrl}/audio/transcriptions`,{method:'POST',headers:{authorization:`Bearer ${m.key}`},body:form,signal:AbortSignal.timeout(120000)},{source:'transcription',protocol:'transcription',model,units:{inputBytes:bytes}});const buffer=Buffer.from(await upstream.arrayBuffer());return reply.code(upstream.status).header('content-type',upstream.headers.get('content-type')??'application/json').send(buffer)}catch(e){return proxyError(reply,true,e instanceof QuotaError?429:502,5021,e instanceof QuotaError?e.message:'音频上游调用失败')}
  })
  app.get('/api/v1/llm/v1/models',routeOptions,async(_req,reply)=>{
    const m=resolveChatConfig(db,app.deps.cfg)
    return reply.send({object:'list',data:m.configured?[{id:m.model,object:'model',created:0,owned_by:'echo'}]:[]})
  })

  app.get('/api/v1/llm/health', { preHandler: app.authenticate }, async (_req, reply) => {
    const m = resolveChatConfig(db, cfg)
    return reply.send(
      ok({
        configured: m.configured,
        provider: m.provider,
        model: m.model,
        source: m.source,
        credentialError: m.credentialError
      })
    )
  })
}
