import type { FastifyInstance } from 'fastify'
import { ok } from '../reply.js'
import { encryptSecret, decryptSecret } from '../crypto.js'
import { requireAdmin } from '../auth.js'

const ROW_ID = 'org-default'

export function registerModelConfigRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  app.get('/api/model-config', { preHandler: app.authenticate }, async (_req, reply) => {
    const row = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(ROW_ID) as any
    if (!row) return reply.send(ok({ baseUrl: null, modelName: null, apiKey: null, allowLocalOverride: true, hasCredential: false }))
    // 方案A(安全降级): 向已登录客户端下发解密后的真实 apiKey, 供本地 agent 直连模型厂商。
    // 代价: key 会落到每台客户端机器。后续升级方案B(服务器模型网关代理)后应收回此下发。
    return reply.send(ok({
      baseUrl: row.base_url, modelName: row.model_name,
      apiKey: row.credential ? decryptSecret(row.credential) : null,
      allowLocalOverride: !!row.allow_local_override, hasCredential: !!row.credential
    }))
  })

  app.put('/api/admin/model-config', { preHandler: [app.authenticate, requireAdmin] }, async (req, reply) => {
    const { baseUrl, modelName, credential, allowLocalOverride } = (req.body ?? {}) as any
    const enc = credential ? encryptSecret(credential) : null
    db.prepare(`
      INSERT INTO model_configs (id, scope, base_url, model_name, credential, allow_local_override, updated_at)
      VALUES (?, 'org', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url, model_name=excluded.model_name,
        credential=COALESCE(excluded.credential, model_configs.credential),
        allow_local_override=excluded.allow_local_override, updated_at=excluded.updated_at
    `).run(ROW_ID, baseUrl ?? null, modelName ?? null, enc, allowLocalOverride ? 1 : 0, Date.now())
    return reply.send(ok({ updated: true }))
  })
}
