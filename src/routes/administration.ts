import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAdmin, type AuthedRequest } from '../auth/jwt.js'
import { loadManagementContext } from '../auth/scopes.js'
import { findById, getUserGroups } from '../dao/users.js'
import { gatewayBaseUrl } from '../gateway/keys.js'
import { quotaUsage, settings } from '../gateway/usage.js'
import { listDevices, deviceCoverage } from '../operations/devices.js'
import { assetKinds, findKnowledgeAsset, knowledgeAssetsSql } from '../operations/knowledge-assets.js'
import { ok, fail } from '../reply.js'

export function registerAdministrationRoutes(app: FastifyInstance) {
  const { db } = app.deps
  const admin = { preHandler: [app.authenticate, requireAdmin] }

  app.get('/api/v1/admin/knowledge-assets', admin, async (req, reply) => {
    const p = z.object({ q: z.string().max(500).default(''), kind: z.enum(assetKinds).optional() }).safeParse(req.query)
    if (!p.success) return reply.code(400).send(fail(4001, '查询参数错误'))
    const c = (req as AuthedRequest).claims, ctx = loadManagementContext(db, c.sub, c.role)
    const where = [`a.scopeId IN (${ctx.scopeIds.map(() => '?').join(',') || "''"})`, 'a.sensitivity<=?', "s.kind!='personal'"]
    const args: any[] = [...ctx.scopeIds, ctx.clearance]
    if (p.data.q) { where.push('a.title LIKE ?'); args.push(`%${p.data.q}%`) }
    if (p.data.kind) { where.push('a.kind=?'); args.push(p.data.kind) }
    return reply.send(ok(db.prepare(`SELECT a.*,s.name AS scopeName FROM (${knowledgeAssetsSql}) a
      JOIN v_effective_scopes s ON s.id=a.scopeId WHERE ${where.join(' AND ')} ORDER BY a.updatedAt DESC LIMIT 50`).all(...args)))
  })

  app.get('/api/v1/admin/asset-maintainers', admin, async (req, reply) => {
    const p = z.object({ scopeId: z.string(), sensitivity: z.coerce.number().int().min(0).max(3).default(0) }).safeParse(req.query)
    if (!p.success) return reply.code(400).send(fail(4001, '查询参数错误'))
    const c = (req as AuthedRequest).claims, ctx = loadManagementContext(db, c.sub, c.role)
    const scope = db.prepare('SELECT kind FROM v_effective_scopes WHERE id=?').get(p.data.scopeId) as any
    if (!scope || scope.kind === 'personal' || !ctx.scopeIds.includes(p.data.scopeId) || p.data.sensitivity > ctx.clearance)
      return reply.code(404).send(fail(4041, '共享范围不存在或无权访问'))
    return reply.send(ok(db.prepare(`SELECT u.id,u.display_name AS displayName,u.username FROM users u
      WHERE u.status='active' AND u.clearance>=? AND (u.role='admin' OR EXISTS(SELECT 1 FROM v_user_scopes v WHERE v.user_id=u.id AND v.scope_id=?))
      ORDER BY u.display_name,u.username`).all(p.data.sensitivity,p.data.scopeId)))
  })

  app.get('/api/v1/admin/users/:id/overview', admin, async (req, reply) => {
    const { id } = req.params as { id: string }, user = findById(db, id)
    if (!user) return reply.code(404).send(fail(4041, '成员不存在'))
    const keys = db.prepare(`SELECT k.id,k.name,k.prefix,k.device_id AS deviceId,k.created_at AS createdAt,k.last_used_at AS lastUsedAt,k.expires_at AS expiresAt,
      CASE WHEN k.revoked_at IS NOT NULL OR k.token_version!=u.token_version OR u.status!='active' THEN 'revoked' WHEN k.expires_at<=? THEN 'expired' ELSE 'active' END AS status
      FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.user_id=? ORDER BY k.created_at DESC`).all(Date.now(), id)
    const devices = listDevices(db,id)
    const rules = db.prepare(`SELECT * FROM quota_rules WHERE target_type='org' OR (target_type='user' AND target_id=?)
      OR (target_type='department' AND target_id=?) OR (target_type='key' AND target_id IN (SELECT id FROM api_keys WHERE user_id=?))`).all(id,user.departmentId ?? '',id) as any[]
    const summary = db.prepare(`SELECT COUNT(*) AS calls,COALESCE(SUM(total_tokens IS NOT NULL),0) AS knownCalls,COALESCE(SUM(total_tokens),0) AS totalTokens,
      COALESCE(SUM(accounting_state='complete'),0) AS completeCalls,COALESCE(SUM(outcome='succeeded'),0) AS successfulCalls,
      COALESCE(SUM(accounting_state IN ('unknown','partial')),0) AS unsettled FROM model_calls WHERE user_id=? AND started_at>=?`).get(id, Date.now()-30*86400000)
    const scopes = db.prepare(`SELECT s.id,s.name,s.kind FROM v_user_scopes v JOIN v_effective_scopes s ON s.id=v.scope_id
      WHERE v.user_id=? AND s.kind!='personal' ORDER BY s.kind,s.name`).all(id)
    const baseUrl = gatewayBaseUrl(db,`${req.protocol}://${req.host}`)
    const department = user.departmentId ? db.prepare('SELECT name FROM groups WHERE id=?').get(user.departmentId) : null
    return reply.header('cache-control','no-store').send(ok({ user:{...user,groups:getUserGroups(db,id),departmentName:(department as any)?.name},
      scopes,keys,devices,coverage:deviceCoverage(devices),summary,baseUrl,serverUrl:baseUrl.replace(/\/api\/v1\/llm\/v1\/?$/,''),
      quotas:rules.map(q=>({...q,usage:quotaUsage(db,q)})),configRevision:settings(db).revision,
      policyVersion:(db.prepare("SELECT version FROM enterprise_policy WHERE id='default'").get() as any).version }))
  })

  app.post('/api/v1/admin/maintenance/:id/dismiss',admin,async(req,reply)=>{
    const p=z.object({version:z.number().int(),note:z.string().trim().min(3).max(4000)}).safeParse(req.body)
    if(!p.success)return reply.code(400).send(fail(4001,'请填写无需维护的原因，至少 3 个字符'))
    const {id}=req.params as {id:string}
    const result=db.prepare("UPDATE maintenance_tasks SET state='closed',closure_reason='no_action',note=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND state!='closed'").run(p.data.note,Date.now(),id,p.data.version)
    if(!result.changes)return reply.code(409).send(fail(4091,'事项已更新或关闭，请刷新'))
    app.audit(req,'maintenance_change',id,{closed:true,reason:'no_action'})
    return reply.send(ok({updated:true}))
  })

  app.post('/api/v1/admin/maintenance/:id/retest', admin, async (req, reply) => {
    const p=z.object({version:z.number().int(),assetId:z.string().min(1),assetKind:z.enum(assetKinds)}).safeParse(req.body)
    if(!p.success)return reply.code(400).send(fail(4001,'请选择关联知识并刷新任务版本'))
    const {id}=req.params as {id:string},c=(req as AuthedRequest).claims,ctx=loadManagementContext(db,c.sub,c.role)
    const task=db.prepare('SELECT * FROM maintenance_tasks WHERE id=?').get(id) as any
    if(!task)return reply.code(404).send(fail(4041,'维护任务不存在'))
    if(task.version!==p.data.version||task.state==='closed')return reply.code(409).send(fail(4091,'任务已更新或关闭，请刷新'))
    const asset=findKnowledgeAsset(db,ctx,p.data.assetId,p.data.assetKind)
    if(!asset)return reply.code(400).send(fail(4001,'关联知识不存在、不可见或尚未发布'))
    if(asset.kind==='skill')return reply.code(409).send(fail(4091,'技能须在客户端执行验证，请在维护任务中记录实际执行过程与结果'))
    const result=await app.deps.retriever.retrieve(c.sub,{query:task.question,limit:20,scopes:['org','team']})
    const matched=asset.kind==='document'?result.chunks.some(x=>x.docId===asset.id):result.memories.some(x=>x.id===asset.id)
    const verification={method:'retrieval',matched,at:Date.now(),assetId:asset.id,assetKind:asset.kind,assetTitle:asset.title,
      chunks:result.chunks.length,memories:result.memories.length,diagnostics:result.diagnostics,actorId:c.sub}
    const changed=db.prepare(`UPDATE maintenance_tasks SET verification_json=?,result_asset_id=?,result_asset_kind=?,updated_at=?,version=version+1
      WHERE id=? AND version=? AND state!='closed'`).run(JSON.stringify(verification),asset.id,asset.kind,Date.now(),id,p.data.version)
    if(!changed.changes)return reply.code(409).send(fail(4091,'复测期间任务发生变化，请刷新后重试'))
    app.audit(req,'maintenance_change',id,{retested:true,matched,assetId:asset.id})
    return reply.send(ok({...verification,version:p.data.version+1}))
  })
}
