import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requireAdmin, type AuthedRequest } from '../auth/jwt.js'
import { loadManagementContext } from '../auth/scopes.js'
import { processPublication, publicationTables, type PublicationKind } from '../operations/automatic-publication.js'
import { fail, ok } from '../reply.js'
export const securityRecords = `SELECT 'document' AS kind,id,title,submitter_id,target_scope AS scope_id,sensitivity,state,scan_status,scan_report_json,scan_started_at,scan_completed_at,auto_retry_at,review_note,created_at,result_document_id AS asset_id,'document' AS asset_kind FROM document_submissions
    UNION ALL SELECT 'skill',v.id,f.name,v.submitter_id,f.scope_id,0,v.state,v.scan_status,v.scan_report_json,v.scan_started_at,v.scan_completed_at,v.auto_retry_at,v.review_note,v.created_at,f.id,'skill' FROM skill_versions v JOIN skill_families f ON f.id=v.family_id
    UNION ALL SELECT 'promotion',id,COALESCE(json_extract(payload,'$.title'),substr(json_extract(payload,'$.content'),1,120)),submitter_id,target_scope,COALESCE(json_extract(payload,'$.sensitivity'),0),state,scan_status,scan_report_json,scan_started_at,scan_completed_at,auto_retry_at,review_note,created_at,result_id,CASE payload_type WHEN 'memory' THEN 'memory' ELSE 'document' END FROM promotions`
export const securityAttention = `(c.state='pending' AND (c.scan_status='failed' OR COALESCE(c.scan_started_at,c.created_at)<CAST(strftime('%s','now') AS INTEGER)*1000-600000)) OR (c.scan_status='failed' AND d.status='follow_up')`
export function registerSecurityCheckRoutes(app: FastifyInstance) {
  const {db} = app.deps, admin={preHandler:[app.authenticate,requireAdmin]}
  const records=securityRecords
  app.get('/api/v1/admin/security-checks',admin,async(req,reply)=>{
    const p=z.object({kind:z.enum(['document','skill','promotion']).optional(),status:z.enum(['queued','scanning','passed','failed','unknown']).optional(),view:z.enum(['all','attention','isolated','archived']).default('all'),recordId:z.string().max(256).optional(),assetId:z.string().max(256).optional(),page:z.coerce.number().int().min(1).default(1),size:z.coerce.number().int().min(1).max(100).default(25)}).safeParse(req.query)
    if(!p.success)return reply.code(400).send(fail(4001,'筛选参数错误'))
    const ctx=loadManagementContext(db,(req as AuthedRequest).claims.sub,'admin')
    const ids=(db.prepare("SELECT id FROM v_effective_scopes WHERE kind IN ('org','team')").all() as {id:string}[]).map(s=>s.id).filter(id=>ctx.scopeIds.includes(id))
    const where=[`c.scope_id IN (${ids.map(()=>'?').join(',')||"''"})`,'c.sensitivity<=?'],args:any[]=[...ids,ctx.clearance]
    if(p.data.kind){where.push('c.kind=?');args.push(p.data.kind)}
    if(p.data.recordId){where.push('c.id=?');args.push(p.data.recordId)}
    if(p.data.assetId){where.push('c.asset_id=?');args.push(p.data.assetId)}
    const baseWhere=where.join(' AND '),baseArgs=[...args]
    if(p.data.view==='attention')where.push(`(${securityAttention})`)
    if(p.data.view==='isolated')where.push("c.scan_status='failed' AND c.state!='pending' AND COALESCE(d.status,'handled')='handled'")
    if(p.data.view==='archived')where.push("d.status='archived'")
    if(p.data.status){where.push('c.scan_status=?');args.push(p.data.status)}
    const sql=`FROM (${records}) c LEFT JOIN security_dispositions d ON d.kind=c.kind AND d.record_id=c.id JOIN users u ON u.id=c.submitter_id JOIN scopes s ON s.id=c.scope_id WHERE ${where.join(' AND ')}`
    const total=(db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as any).n
    const summary=db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(c.state='pending'),0) AS processing,
      COALESCE(SUM(c.scan_status='failed'),0) AS failed,COALESCE(SUM(c.state='approved'),0) AS published,
      COALESCE(SUM(${securityAttention}),0) AS attention,
      COALESCE(SUM(c.scan_status='failed' AND c.state!='pending' AND COALESCE(d.status,'handled')='handled'),0) AS isolated,
      COALESCE(SUM(d.status='archived'),0) AS archived
      FROM (${records}) c LEFT JOIN security_dispositions d ON d.kind=c.kind AND d.record_id=c.id WHERE ${baseWhere}`).get(...baseArgs)
    const rows=db.prepare(`SELECT c.*,d.status AS disposition,d.note AS dispositionNote,d.updated_at AS dispositionAt,u.display_name AS submitterName,s.name AS scopeName ${sql} ORDER BY c.created_at DESC,c.id LIMIT ? OFFSET ?`).all(...args,p.data.size,(p.data.page-1)*p.data.size) as any[]
    return reply.send(ok({items:rows.map(r=>({...r,scanReport:parseReport(r.scan_report_json),requiresAttention:(r.state==='pending'&&(r.scan_status==='failed'||(r.scan_started_at??r.created_at)<Date.now()-600000))||(r.scan_status==='failed'&&r.disposition==='follow_up'),scan_report_json:undefined})),total,summary,page:p.data.page,size:p.data.size}))
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
    db.prepare('DELETE FROM security_dispositions WHERE kind=? AND record_id=?').run(kind,id)
    app.audit(req,'security_scan_retry',id,{kind})
    const result=await processPublication(app,kind as PublicationKind,id)
    return reply.send(ok(result))
  })
  app.post('/api/v1/admin/security-checks/:kind/:id/disposition',admin,async(req,reply)=>{
    const p=z.object({kind:z.enum(['document','skill','promotion']),id:z.string().min(1)}).safeParse(req.params)
    const body=z.object({status:z.enum(['follow_up','handled','archived']),note:z.string().trim().min(2).max(2000)}).safeParse(req.body)
    if(!p.success||!body.success)return reply.code(400).send(fail(4001,'请选择处理方式并填写处置说明'))
    const c=(req as AuthedRequest).claims,ctx=loadManagementContext(db,c.sub,c.role)
    const row=db.prepare(`SELECT * FROM (${records}) WHERE kind=? AND id=?`).get(p.data.kind,p.data.id) as any
    const scope=row&&db.prepare('SELECT kind FROM scopes WHERE id=?').get(row.scope_id) as any
    if(!row||!scope||scope.kind==='personal'||!ctx.scopeIds.includes(row.scope_id)||row.sensitivity>ctx.clearance)return reply.code(404).send(fail(4041,'记录不存在或无权处理'))
    if(row.state==='pending'||row.scan_status!=='failed')return reply.code(409).send(fail(4091,'仅已完成的失败检查可记录处置，不会中断自动重试'))
    db.prepare(`INSERT INTO security_dispositions(kind,record_id,status,note,actor_id,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,record_id) DO UPDATE SET status=excluded.status,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at`).run(p.data.kind,p.data.id,body.data.status,body.data.note,c.sub,Date.now())
    app.audit(req,'security_disposition',p.data.id,{kind:p.data.kind,status:body.data.status})
    return reply.send(ok({updated:true,publicationState:row.state,scanStatus:row.scan_status}))
  })

}

function parseReport(value: string|null) { try { return value ? JSON.parse(value) : null } catch { return null } }
