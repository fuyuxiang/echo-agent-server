import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { encryptSecret, deriveKey } from '../crypto.js'
import { requireAdmin, type AuthedRequest } from '../auth/jwt.js'
import { loadConfigFromDb } from '../config.js'
import { createEmbedder } from '../models/embedder.js'
import { createReranker } from '../models/reranker.js'
import { resolveChatConfig } from '../models/chat-config.js'
import { createVlmClient } from '../kb/services/vlm.js'
import { VECTOR_INDEX_DIM } from '../kb/vector-schema.js'

/** PUT 时的 warn,落到 stderr —— 与启动期 createEmbedder/createReranker 保持一致。 */
const hotWarn = (m: string): void => {
  // eslint-disable-next-line no-console
  console.warn(`[echo-server] ${m}`)
}

const ROW_ID = 'default'

const PutSchema = z.object({
  chatProvider: z.string().min(1),
  chatModel: z.string().min(1),
  chatBaseUrl: z.string().optional(),
  // 留空表示保留现有 Key,不是清空 —— 管理员改模型名时不该被迫重输密钥。
  chatKey: z.string().optional(),
  embedModel: z.string().min(1),
  embedDim: z.coerce.number().int().positive(),
  rerankModel: z.string().optional(),
  vlmModel: z.string().optional()
})

export function registerModelConfigRoutes(app: FastifyInstance): void {
  const { db, cfg } = app.deps
  const masterKey = deriveKey(cfg.masterKey)

  /**
   * 实际生效的模型能力。
   *
   * 配置里的 embedModel 是"打算用什么",这里是"真正在跑什么" —— 未配置
   * ECHO_EMBED_URL 时后者是占位实现。两者不一致时管理端要能看出来,否则
   * 会把"检索质量差"归因到文档质量上。
   *
   * 关键:每次调用都从 app.deps 现读 embedder / reranker,而不是在注册时
   * 解构出闭包常量 —— 因为 PUT 会替换 deps 上的实例,解构出来的旧引用会
   * 永远指向"第一次启动时的"模型,让 GET 显示过期信息。
   */
  const runtimeModels = (): Record<string, unknown> => {
    const e = app.deps.embedder
    const r = app.deps.reranker
    return {
      runtime: {
        embedder: e.model,
        embedDim: e.dim,
        dimensionCompatible: e.dim === VECTOR_INDEX_DIM,
        semantic: e.semantic,
        reranker: r.model,
        crossEncoder: r.crossEncoder,
        productionReady: e.semantic && r.crossEncoder && e.dim === VECTOR_INDEX_DIM
      }
    }
  }

  /**
   * 客户端只拿到非敏感字段。
   *
   * 明文 API Key 一旦下发,就散落在每台员工机器的内存、磁盘缓存和崩溃
   * 日志里,且离职或换机后无法回收 —— 撤销一个 Key 需要通知所有客户端,
   * 做不到。推理改由服务端代理,Key 只存服务端一处;副产品是成本归因与
   * 限流有了统一落点。
   */
  app.get('/api/v1/model-config', { preHandler: app.authenticate }, async (_req, reply) => {
    const row = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(ROW_ID) as
      | Record<string, unknown>
      | undefined
    const chat = resolveChatConfig(db, cfg)

    if (!row) {
      return reply.send(
        ok({
          configured: chat.configured,
          chatProvider: chat.provider,
          chatModel: chat.model,
          chatBaseUrl: chat.baseUrl,
          embedModel: cfg.embedModel,
          embedDim: cfg.embedDim,
          rerankModel: cfg.rerankModel,
          vlmModel: cfg.vlmModel ?? null,
          hasCredential: !!chat.key,
          credentialError: chat.credentialError,
          source: chat.source,
          proxied: true,
          ...runtimeModels()
        })
      )
    }

    return reply.send(
      ok({
        configured: true,
        chatProvider: chat.provider,
        chatModel: chat.model,
        chatBaseUrl: chat.baseUrl,
        embedModel: row.embed_model,
        embedDim: row.embed_dim,
        rerankModel: row.rerank_model,
        vlmModel: row.vlm_model,
        // 刻意不含任何 Key 字段。客户端据 proxied=true 走 /api/v1/llm/chat。
        hasCredential: !!chat.key,
        credentialError: chat.credentialError,
        source: chat.source,
        proxied: true,
        updatedAt: row.updated_at,
        ...runtimeModels()
      })
    )
  })

  app.put(
    '/api/v1/admin/model-config',
    { preHandler: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const parsed = PutSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send(fail(4001, `参数错误: ${parsed.error.issues[0]?.message}`))
      }
      const v = parsed.data
      if (v.embedDim !== VECTOR_INDEX_DIM) {
        return reply.code(409).send(
          fail(
            4092,
            `当前向量索引维度固定为 ${VECTOR_INDEX_DIM}，不能热切换为 ${v.embedDim}；请先执行全量重建索引迁移`
          )
        )
      }
      const actor = (req as AuthedRequest).claims.sub
      const enc = v.chatKey ? encryptSecret(v.chatKey, masterKey) : null

      db.prepare(
        `INSERT INTO model_configs (id, chat_provider, chat_model, chat_base_url,
                                    chat_key_enc, embed_model, embed_dim,
                                    rerank_model, vlm_model, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           chat_provider = excluded.chat_provider,
           chat_model    = excluded.chat_model,
           chat_base_url = excluded.chat_base_url,
           chat_key_enc  = COALESCE(excluded.chat_key_enc, model_configs.chat_key_enc),
           embed_model   = excluded.embed_model,
           embed_dim     = excluded.embed_dim,
           rerank_model  = excluded.rerank_model,
           vlm_model     = excluded.vlm_model,
           updated_by    = excluded.updated_by,
           updated_at    = excluded.updated_at`
      ).run(
        ROW_ID,
        v.chatProvider,
        v.chatModel,
        v.chatBaseUrl ?? null,
        enc,
        v.embedModel,
        v.embedDim,
        v.rerankModel ?? null,
        v.vlmModel ?? null,
        actor,
        Date.now()
      )

      // 热加载:把 DB 行覆盖到 cfg 后,立刻重建 embedder 与 reranker,
      // 并赋回 app.deps。由于 Retriever(this.deps === app.deps)持有同一
      // 对象引用,下一次请求会同时拿到新实例 —— 不需要锁,不需要重启。
      const newCfg = loadConfigFromDb(db, cfg)
      app.deps.cfg = newCfg
      app.deps.embedder = createEmbedder(newCfg, hotWarn)
      app.deps.reranker = createReranker(newCfg, hotWarn)
      app.deps.vlmClient = createVlmClient(newCfg, hotWarn)

      app.audit(req, 'config_change', ROW_ID, {
        chatModel: v.chatModel,
        embedModel: v.embedModel,
        embedDim: v.embedDim,
        rerankModel: v.rerankModel,
        vlmModel: v.vlmModel
      })
      return reply.send(ok({ updated: true }))
    }
  )
}
