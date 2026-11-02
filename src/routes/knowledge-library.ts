import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthedRequest } from '../auth/jwt.js'
import { loadAccessContext, type AccessContext } from '../auth/scopes.js'
import { fail, ok } from '../reply.js'

const resources = ['memories', 'documents', 'skills', 'memory-submissions', 'document-submissions', 'skill-submissions'] as const
type Resource = typeof resources[number]
const Query = z.object({
  resource: z.enum([...resources, 'summary']),
  scopeId: z.string().max(256).optional(),
  q: z.string().max(2000).optional(),
  filter: z.string().max(30).optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20)
})
interface Source { select: string; from: string; where: string[]; params: unknown[]; order: string; scope: string; search: string; filters: Record<string, string> }

/** Dedicated management pages share one bounded query contract. Existing array
 * endpoints remain unchanged for runtime and older desktop clients. */
function source(resource: Resource, ctx: AccessContext): Source {
  const visible = (column: string) => `${column} IN (${ctx.scopeIds.map(() => '?').join(',') || 'NULL'})`
  const shared = 'JOIN v_effective_scopes s ON s.id = '
  if (resource === 'memories') return {
    select: `m.id,m.kind,m.content,m.rationale,m.evidence,m.confidence,m.valid_until AS validUntil,
      m.workspace_ref AS workspaceRef,m.outcome,m.trust,m.status,m.updated_at AS updatedAt,
      s.id AS scopeId,s.kind AS scopeKind,s.name AS scopeName,u.display_name AS authorName`,
    from: `org_memories m ${shared}m.scope_id LEFT JOIN users u ON u.id=m.author_id`,
    where: [visible('m.scope_id'), 'm.sensitivity<=?', "m.status='active'"], params: [...ctx.scopeIds,ctx.clearance],
    scope:'m.scope_id', search:"m.content || ' ' || COALESCE(m.rationale,'') || ' ' || COALESCE(m.outcome,'') || ' ' || COALESCE(m.workspace_ref,'')",
    order:'m.hit_count DESC,m.updated_at DESC,m.id',
    filters:Object.fromEntries(['fact','decision','convention','pitfall','howto'].map(kind=>[kind,`m.kind='${kind}'`]))
  }
  if (resource === 'documents') return {
    select:`d.id,d.title,d.source_type AS sourceType,d.status,d.fail_reason AS failReason,d.byte_size AS byteSize,
      d.owner_id AS ownerId,d.updated_at AS updatedAt,s.id AS scopeId,s.kind AS scopeKind,s.name AS scopeName,
      u.display_name AS ownerName,(SELECT COUNT(*) FROM chunks c WHERE c.doc_id=d.id) AS chunkCount`,
    from:`documents d JOIN document_families f ON f.id=d.family_id ${shared}d.scope_id LEFT JOIN users u ON u.id=d.owner_id`,
    where:[visible('d.scope_id'),'d.sensitivity<=?',"f.state='active'","d.status!='archived'","(d.status!='ready' OR f.current_document_id=d.id)"],
    params:[...ctx.scopeIds,ctx.clearance],scope:'d.scope_id',search:'d.title',order:'d.updated_at DESC,d.id',
    filters:{ready:"d.status='ready'",processing:"d.status IN ('pending','parsing','chunking','embedding')",failed:"d.status='failed'"}
  }
  if (resource === 'skills') return {
    select:`sf.id AS skillId,sv.id AS versionId,sf.name,sf.description,sv.version,sf.mandatory,
      sf.allow_personal_override AS allowPersonalOverride,sf.updated_at AS updatedAt,s.id AS scopeId,
      s.kind AS scopeKind,s.name AS scopeName,(sf.mandatory OR COALESCE(pref.enabled,0)) AS enabled`,
    from:`skill_families sf JOIN skill_versions sv ON sv.id=sf.current_version_id AND sv.state='approved'
      ${shared}sf.scope_id LEFT JOIN skill_user_preferences pref ON pref.skill_id=sf.id AND pref.user_id=?`,
    where:[visible('sf.scope_id'),"sf.state='active'"],params:[ctx.userId,...ctx.scopeIds],scope:'sf.scope_id',
    search:"sf.name || ' ' || sf.description",order:'sf.updated_at DESC,sf.id',
    filters:{installed:'(sf.mandatory=1 OR pref.enabled=1)',available:'sf.mandatory=0 AND COALESCE(pref.enabled,0)=0',mandatory:'sf.mandatory=1'}
  }
  const submissionFilters = (state: string, scan?: string) => ({
    pending:scan?`(${state}='pending' OR ${scan} IN ('queued','scanning'))`:`${state}='pending'`,
    approved:`${state}='approved'`,rejected:`${state}='rejected'`,withdrawn:`${state}='withdrawn'`
  })
  if(resource==='memory-submissions') return {
    select:`p.id,p.payload_type AS payloadType,p.payload,p.source,p.state,p.review_note AS reviewNote,
      p.created_at AS createdAt,s.id AS scopeId,s.name AS scopeName,s.kind AS scopeKind`,
    from:`promotions p ${shared}p.target_scope`,where:['p.submitter_id=?',"p.payload_type='memory'"],params:[ctx.userId],
    scope:'p.target_scope',search:'p.payload',order:'p.created_at DESC,p.id',filters:submissionFilters('p.state')
  }
  if(resource==='skill-submissions') return {
    select:`sv.id AS submissionId,sf.name,sv.version,sv.state,sv.scan_status AS scanStatus,
      sv.scan_report_json AS scanReportJson,sv.review_note AS reviewNote,sv.created_at AS createdAt,
      s.id AS scopeId,s.name AS scopeName,s.kind AS scopeKind`,
    from:`skill_versions sv JOIN skill_families sf ON sf.id=sv.family_id ${shared}sf.scope_id`,
    where:['sv.submitter_id=?'],params:[ctx.userId],scope:'sf.scope_id',search:'sf.name',order:'sv.created_at DESC,sv.id',
    filters:{...submissionFilters('sv.state','sv.scan_status'),revoked:"sv.state='revoked'"}
  }
  return {
    select:`ds.id,ds.title,ds.source_type AS sourceType,ds.byte_size AS byteSize,ds.state,
      ds.scan_status AS scanStatus,ds.scan_report_json AS scanReportJson,ds.review_note AS reviewNote,
      ds.result_document_id AS resultDocumentId,ds.created_at AS createdAt,s.id AS scopeId,s.name AS scopeName,s.kind AS scopeKind`,
    from:`document_submissions ds ${shared}ds.target_scope`,where:['ds.submitter_id=?','ds.hidden_by_submitter=0'],params:[ctx.userId],
    scope:'ds.target_scope',search:'ds.title',order:'ds.created_at DESC,ds.id',filters:submissionFilters('ds.state','ds.scan_status')
  }
}

function parseJson(value:unknown,fallback:unknown):unknown {
  if(typeof value!=='string')return value??fallback
  try{return JSON.parse(value)}catch{return fallback}
}
function hydrate(resource:Resource,row:Record<string,unknown>) {
  if(resource==='memories') return {...row,evidence:parseJson(row.evidence,[]),stale:typeof row.validUntil==='number'&&row.validUntil<Date.now()}
  if(resource==='memory-submissions')return {...row,payload:parseJson(row.payload,{})}
  if(resource==='skills')return {...row,mandatory:!!row.mandatory,enabled:!!row.enabled,allowPersonalOverride:!!row.allowPersonalOverride}
  if(resource==='documents')return {...row,tags:[]}
  return {...row,scanReport:parseJson(row.scanReportJson,null),scanReportJson:undefined}
}

export function registerKnowledgeLibraryRoutes(app:FastifyInstance):void {
  const {db}=app.deps
  app.get('/api/v1/knowledge/library',{preHandler:app.authenticate},async(req,reply)=>{
    const parsed=Query.safeParse(req.query??{})
    if(!parsed.success)return reply.code(400).send(fail(4001,'查询参数错误'))
    const query=parsed.data
    const ctx=loadAccessContext(db,(req as AuthedRequest).claims.sub)
    const count=(resource:Resource,filter?:string)=>{
      const s=source(resource,ctx)
      if(filter)s.where.push(s.filters[filter])
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${s.from} WHERE ${s.where.join(' AND ')}`).get(...s.params) as {n:number}).n
    }
    if(query.resource==='summary')return reply.send(ok({
      memories:count('memories'),documents:count('documents'),documentReady:count('documents','ready'),documentProcessing:count('documents','processing'),
      skills:count('skills'),skillInstalled:count('skills','installed'),skillMandatory:count('skills','mandatory'),
      memoryPending:count('memory-submissions','pending'),documentPending:count('document-submissions','pending'),skillPending:count('skill-submissions','pending')
    }))
    const s=source(query.resource,ctx)
    if(query.scopeId){s.where.push(`${s.scope}=?`);s.params.push(query.scopeId)}
    if(query.q){s.where.push(`(${s.search}) LIKE ? ESCAPE '\\'`);s.params.push(`%${query.q.replace(/[\\%_]/g,'\\$&')}%`)}
    if(query.filter){
      if(!s.filters[query.filter])return reply.code(400).send(fail(4001,'筛选条件无效'))
      s.where.push(s.filters[query.filter])
    }
    const where=s.where.join(' AND ')
    const total=(db.prepare(`SELECT COUNT(*) AS n FROM ${s.from} WHERE ${where}`).get(...s.params) as {n:number}).n
    const rows=db.prepare(`SELECT ${s.select} FROM ${s.from} WHERE ${where} ORDER BY ${s.order} LIMIT ? OFFSET ?`)
      .all(...s.params,query.size,(query.page-1)*query.size) as Record<string,unknown>[]
    return reply.send(ok({items:rows.map(row=>hydrate(query.resource as Resource,row)),total,page:query.page,size:query.size}))
  })
}
