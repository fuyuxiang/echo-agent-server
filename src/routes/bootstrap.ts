import type { FastifyInstance } from 'fastify'
import type { AuthedRequest } from '../auth/jwt.js'
import { requireAdmin } from '../auth/jwt.js'
import { findById, getUserGroups } from '../dao/users.js'
import { ok } from '../reply.js'
import { serverSigningPublicKey, signServerPayload } from '../server-signing.js'
import { z } from 'zod'

const POLICY_TTL_MS = 24 * 60 * 60_000

interface PolicyRow {
  version: number
  allowLocalKnowledge: number
  allowPersonalCloud: number
  allowSkillSubmission: number
  offlineEnterpriseContent: number
  managedSkillLeaseHours: number
  updatedAt: number
}

function readPolicy(app: FastifyInstance): PolicyRow {
  return app.deps.db.prepare(
    `SELECT version, allow_local_knowledge AS allowLocalKnowledge,
            allow_personal_cloud AS allowPersonalCloud,
            allow_skill_submission AS allowSkillSubmission,
            offline_enterprise AS offlineEnterpriseContent,
            managed_lease_hours AS managedSkillLeaseHours,
            updated_at AS updatedAt
       FROM enterprise_policy WHERE id='default'`
  ).get() as PolicyRow
}

/**
 * 桌面端启动后的单一权威配置入口。客户端只需预配置 HTTPS 服务器地址，
 * 登录后所有 scope/功能开关/租约都从这里取，不依赖客户端与服务端同机。
 */
export function registerBootstrapRoutes(app: FastifyInstance): void {
  const { db, cfg } = app.deps
  app.get('/api/v1/client/bootstrap', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const user = findById(db, claims.sub)!
    const scopes = db.prepare(
      `SELECT s.id, s.kind, s.name, s.group_id AS groupId,
              s.owner_user_id AS ownerUserId
         FROM v_user_scopes v
         JOIN v_effective_scopes s ON s.id = v.scope_id
        WHERE v.user_id = ?
        ORDER BY CASE s.kind WHEN 'personal' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
                 s.name`
    ).all(claims.sub)

    const issuedAt = Date.now()
    const stored = readPolicy(app)
    const policy = {
      version: stored.version,
      issuedAt,
      expiresAt: issuedAt + POLICY_TTL_MS,
      allowLocalKnowledge: !!stored.allowLocalKnowledge,
      allowPersonalCloud: !!stored.allowPersonalCloud,
      allowSkillSubmission: !!stored.allowSkillSubmission,
      offlineEnterpriseContent: !!stored.offlineEnterpriseContent,
      managedSkillLeaseHours: stored.managedSkillLeaseHours
    }
    // 签名用于防止本地缓存被手工改宽。客户端仍可把策略收紧，
    // 但不得在无新签名时放宽。
    const policyPayload = JSON.stringify(policy)
    const policySignature = signServerPayload(cfg.masterKey, policyPayload)

    return reply.send(ok({
      apiVersion: 1,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        clearance: user.clearance,
        groups: getUserGroups(db, user.id)
      },
      scopes,
      policy,
      policyPayload,
      policySignature,
      signingPublicKey: serverSigningPublicKey(cfg.masterKey),
      skillCursor: '0',
      serverTime: Date.now(),
      endpoints: {
        ask: '/api/v1/knowledge/ask',
        mcp: '/mcp',
        documentSubmissions: '/api/v1/document-submissions'
      }
    }))
  })

  app.get('/api/v1/admin/enterprise-policy', {
    preHandler: [app.authenticate, requireAdmin]
  }, async (_req, reply) => reply.send(ok(readPolicy(app))))

  app.put('/api/v1/admin/enterprise-policy', {
    preHandler: [app.authenticate, requireAdmin]
  }, async (req, reply) => {
    const parsed = z.object({
      allowLocalKnowledge: z.boolean(),
      allowPersonalCloud: z.boolean(),
      allowSkillSubmission: z.boolean(),
      offlineEnterpriseContent: z.boolean(),
      managedSkillLeaseHours: z.number().int().min(1).max(168)
    }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 4001, msg: '参数错误' })
    const claims = (req as AuthedRequest).claims
    const now = Date.now()
    db.prepare(
      `UPDATE enterprise_policy
          SET version=version+1, allow_local_knowledge=?, allow_personal_cloud=?,
              allow_skill_submission=?, offline_enterprise=?, managed_lease_hours=?,
              updated_by=?, updated_at=?
        WHERE id='default'`
    ).run(
      Number(parsed.data.allowLocalKnowledge), Number(parsed.data.allowPersonalCloud),
      Number(parsed.data.allowSkillSubmission), Number(parsed.data.offlineEnterpriseContent),
      parsed.data.managedSkillLeaseHours, claims.sub, now
    )
    app.audit(req, 'enterprise_policy_update', 'default', parsed.data)
    return reply.send(ok(readPolicy(app)))
  })
}
