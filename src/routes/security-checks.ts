import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requireAdmin, type AuthedRequest } from '../auth/jwt.js'
import { loadManagementContext } from '../auth/scopes.js'
import { processPublication, publicationTables, type PublicationKind } from '../operations/automatic-publication.js'
import { fail, ok } from '../reply.js'
export function registerSecurityCheckRoutes(app: FastifyInstance) {
  const {db} = app.deps, admin={preHandler:[app.authenticate,requireAdmin]}
  const records=`SELECT 'document' AS kind,id,title,submitter_id,target_scope AS scope_id,sensitivity,state,scan_status,scan_report_json,scan_started_at,scan_completed_at,auto_retry_at,review_note,created_at FROM document_submissions
    UNION ALL SELECT 'skill',v.id,f.name,v.submitter_id,f.scope_id,0,v.state,v.scan_status,v.scan_report_json,v.scan_started_at,v.scan_completed_at,v.auto_retry_at,v.review_note,v.created_at FROM skill_versions v JOIN skill_families f ON f.id=v.family_id
    UNION ALL SELECT 'promotion',id,COALESCE(json_extract(payload,'$.title'),substr(json_extract(payload,'$.content'),1,120)),submitter_id,target_scope,COALESCE(json_extract(payload,'$.sensitivity'),0),state,scan_status,scan_report_json,scan_started_at,scan_completed_at,auto_retry_at,review_note,created_at FROM promotions`
  app.get('/api/v1/admin/security-checks',admin,async(req,reply)=>{
    const p=z.object({kind:z.enum(['document','skill','promotion']).optional(),status:z.enum(['queued','scanning','passed','failed','unknown']).optional(),page:z.coerce.number().int().min(1).default(1),size:z.coerce.number().int().min(1).max(100).default(25)}).safeParse(req.query)
    if(!p.success)return reply.code(400).send(fail(4001,'筛选参数错误'))
    const ctx=loadManagementContext(db,(req as AuthedRequest).claims.sub,'admin')
    const ids=(db.prepare("SELECT id FROM v_effective_scopes WHERE kind IN ('org','team')").all() as {id:string}[]).map(s=>s.id).filter(id=>ctx.scopeIds.includes(id))
    const where=[`c.scope_id IN (${ids.map(()=>'?').join(',')||"''"})`,'c.sensitivity<=?'],args:any[]=[...ids,ctx.clearance]
    if(p.data.kind){where.push('c.kind=?');args.push(p.data.kind)}
    const baseWhere=where.join(' AND '),baseArgs=[...args]
    if(p.data.status){where.push('c.scan_status=?');args.push(p.data.status)}
    const sql=`FROM (${records}) c JOIN users u ON u.id=c.submitter_id JOIN scopes s ON s.id=c.scope_id WHERE ${where.join(' AND ')}`
    const total=(db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as any).n
    const summary=db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN c.state='pending' THEN 1 ELSE 0 END) AS processing,SUM(CASE WHEN c.scan_status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN c.state='approved' THEN 1 ELSE 0 END) AS published FROM (${records}) c WHERE ${baseWhere}`).get(...baseArgs)
    const rows=db.prepare(`SELECT c.*,u.display_name AS submitterName,s.name AS scopeName ${sql} ORDER BY c.created_at DESC,c.id LIMIT ? OFFSET ?`).all(...args,p.data.size,(p.data.page-1)*p.data.size) as any[]
    return reply.send(ok({items:rows.map(r=>({...r,scanReport:r.scan_report_json?JSON.parse(r.scan_report_json):null,scan_report_json:undefined})),total,summary,page:p.data.page,size:p.data.size}))
  })
  app.post('/api/v1/admin/security-checks/:kind/:id/retry',admin,async(req,reply)=>{
    const p=z.object({kind:z.enum(['document','skill','promotion']),id:z.string().min(1)}).safeParse(req.params)
    if(!p.success)return reply.code(400).send(fail(4001,'参数错误'))
    const {kind,id}=p.data,table=publicationTables[kind]
    const row:any=kind==='skill'?db.prepare('SELECT v.*,f.scope_id AS target_scope FROM skill_versions v JOIN skill_families f ON f.id=v.family_id WHERE v.id=?').get(id):db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
    const ctx=loadManagementContext(db,(req as AuthedRequest).claims.sub,'admin')
    const scope=row&&db.prepare('SELECT kind FROM scopes WHERE id=?').get(row.target_scope) as any
    if(!row||!scope||scope.kind==='personal'||!ctx.scopeIds.includes(row.target_scope)||(row.sensitivity??0)>ctx.clearance)return reply.code(404).send(fail(4041,'记录不存在或无权处理'))
    if(!['pending','rejected'].includes(row.state))return reply.code(409).send(fail(4091,'已发布、已撤回或已停用记录不能重新发布；请提交新版本'))
    const now=Date.now()
    const updated=db.prepare(`UPDATE ${table} SET state='pending',scan_status='queued',auto_retry_at=NULL,scan_started_at=NULL WHERE id=? AND state IN ('pending','rejected') AND (review_lock IS NULL OR review_lease_until<?)`).run(id,now)
    if(!updated.changes)return reply.code(409).send(fail(4091,'该记录正在检查，请稍后刷新'))
    app.audit(req,'security_scan_retry',id,{kind})
    const result=await processPublication(app,kind as PublicationKind,id)
    return reply.send(ok(result))
  })
}
