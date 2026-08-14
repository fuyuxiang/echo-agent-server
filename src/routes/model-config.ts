import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { encryptSecret, deriveKey } from '../crypto.js'
import { requireAdmin, type AuthedRequest } from '../auth/jwt.js'

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
  const { db, cfg, embedder, reranker } = app.deps
  const masterKey = deriveKey(cfg.masterKey)

  /**
   * 实际生效的模型能力。
   *
   * 配置里的 embedModel 是"打算用什么",这里是"真正在跑什么" —— 未配置
   * ECHO_EMBED_URL 时后者是占位实现。两者不一致时管理端要能看出来,否则
   * 会把"检索质量差"归因到文档质量上。
   */
  const runtimeModels = (): Record<string, unknown> => ({
    runtime: {
      embedder: embedder.model,
      semantic: embedder.semantic,
      reranker: reranker.model,
      crossEncoder: reranker.crossEncoder,
      productionReady: embedder.semantic && reranker.crossEncoder
    }
  })

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

    if (!row) {
      return reply.send(
        ok({
          configured: false,
          chatProvider: null,
          chatModel: null,
          embedModel: null,
          embedDim: null,
          hasCredential: false,
          proxied: true,
          ...runtimeModels()
        })
      )
    }

    return reply.send(
      ok({
        configured: true,
        chatProvider: row.chat_provider,
        chatModel: row.chat_model,
        chatBaseUrl: row.chat_base_url,
        embedModel: row.embed_model,
        embedDim: row.embed_dim,
        rerankModel: row.rerank_model,
        vlmModel: row.vlm_model,
        // 刻意不含任何 Key 字段。客户端据 proxied=true 走 /api/v1/llm/chat。
        hasCredential: !!row.chat_key_enc,
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

      app.audit(req, 'config_change', ROW_ID, { chatModel: v.chatModel })
      return reply.send(ok({ updated: true }))
    }
  )
}
