import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthedRequest } from '../auth/jwt.js'
import { findDocumentFolder, folderBreadcrumbs, importDocumentFolders } from '../dao/document-folders.js'
import { loadManagementContext, canPublishDocument, loadAccessContext, type AccessContext } from '../auth/scopes.js'
import { fail, ok } from '../reply.js'

const resources = ['memories', 'documents', 'skills', 'memory-submissions', 'document-submissions', 'skill-submissions'] as const
type Resource = typeof resources[number]
const Query = z.object({
  resource: z.enum([...resources, 'summary']),
  scopeId: z.string().max(256).optional(),
  q: z.string().max(2000).optional(),
  folderId: z.string().min(1).max(256).optional(),
  filter: z.string().max(30).optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20)
})
interface Source { select: string; from: string; where: string[]; params: unknown[]; order: string; scope: string; search: string; filters: Record<string, string> }

// A degraded index can still contain vectors from successful embedding batches.
const documentVectors = 'FROM chunks vc JOIN chunk_vectors v ON v.chunk_id=vc.id WHERE vc.doc_id=d.id'
const degradedDocument = "d.status='ready' AND d.fts_status='ready' AND d.vector_status='degraded'"

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
    select:`d.id,d.title,f.folder_id AS folderId,d.source_type AS sourceType,d.status,d.fail_reason AS failReason,d.byte_size AS byteSize,
      d.fts_status AS ftsStatus,d.vector_status AS vectorStatus,
      d.owner_id AS ownerId,d.updated_at AS updatedAt,s.id AS scopeId,s.kind AS scopeKind,s.name AS scopeName,
      u.display_name AS ownerName,(SELECT COUNT(*) FROM chunks c WHERE c.doc_id=d.id) AS chunkCount,
      (SELECT COUNT(*) ${documentVectors}) AS vectorChunkCount`,
    from:`documents d JOIN document_families f ON f.id=d.family_id ${shared}d.scope_id LEFT JOIN users u ON u.id=d.owner_id`,
    where:[visible('d.scope_id'),'d.sensitivity<=?',"f.state='active'","d.status!='archived'","(d.status!='ready' OR f.current_document_id=d.id)"],
    params:[...ctx.scopeIds,ctx.clearance],scope:'d.scope_id',search:'d.title',order:'d.updated_at DESC,d.id',
    filters:{
      ready:"d.status='ready'",processing:"d.status IN ('pending','parsing','chunking','embedding')",failed:"d.status='failed'",
      keywordOnly:`${degradedDocument} AND NOT EXISTS (SELECT 1 ${documentVectors})`,
      semanticPartial:`${degradedDocument} AND EXISTS (SELECT 1 ${documentVectors})`
    }
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
  app.post('/api/v1/document-folders/import',{preHandler:app.authenticate},async(req,reply)=>{
    const parsed=z.object({scopeId:z.string().min(1).max(256),parentFolderId:z.string().min(1).max(256).nullish(),paths:z.array(z.string().min(1).max(1024)).min(1).max(5000)}).safeParse(req.body)
    if(!parsed.success)return reply.code(400).send(fail(4001,'目录参数无效'))
    const {scopeId,parentFolderId,paths}=parsed.data
    const claims=(req as AuthedRequest).claims
    const ctx=loadManagementContext(db,claims.sub,claims.role)
    if(!canPublishDocument(db,ctx,claims.role,scopeId))return reply.code(403).send(fail(4033,'没有目标范围的文档发布权限'))
    const scope=db.prepare('SELECT kind FROM v_effective_scopes WHERE id=?').get(scopeId) as {kind:string}|undefined
    if(scope?.kind==='personal'&&(db.prepare("SELECT allow_personal_cloud AS enabled FROM enterprise_policy WHERE id='default'").get() as {enabled:number}|undefined)?.enabled===0)return reply.code(403).send(fail(4036,'企业策略已禁用个人云知识'))
    if(parentFolderId&&findDocumentFolder(db,parentFolderId)?.scopeId!==scopeId)return reply.code(404).send(fail(4041,'目标目录不存在或不属于该范围'))
    try{
      const folders=importDocumentFolders(db,scopeId,parentFolderId??null,paths,claims.sub)
      app.audit(req,'document_folders_import',scopeId,{folderCount:folders.length,parentFolderId:parentFolderId??null})
      return reply.send(ok({folders}))
    }catch(error){return reply.code(400).send(fail(4001,error instanceof Error?error.message:'目录创建失败'))}
  })
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
      memories:count('memories'),documents:count('documents'),documentReady:count('documents','ready'),documentProcessing:count('documents','processing'),documentKeywordOnly:count('documents','keywordOnly'),
      documentSemanticPartial:count('documents','semanticPartial'),
      skills:count('skills'),skillInstalled:count('skills','installed'),skillMandatory:count('skills','mandatory'),
      memoryPending:count('memory-submissions','pending'),documentPending:count('document-submissions','pending'),skillPending:count('skill-submissions','pending')
    }))
    const s=source(query.resource,ctx)
    const browsing=query.resource==='documents'&&query.folderId!==undefined
    let breadcrumbs:ReturnType<typeof folderBreadcrumbs>=[]
    if(browsing&&query.folderId!=='root'){
      const folder=findDocumentFolder(db,query.folderId!)
      if(!folder||!ctx.scopeIds.includes(folder.scopeId)||(query.scopeId&&query.scopeId!==folder.scopeId))return reply.code(404).send(fail(4041,'目录不存在或无权访问'))
      breadcrumbs=folderBreadcrumbs(db,folder.id)
    }
    if(browsing&&!query.q){s.where.push('f.folder_id IS ?');s.params.push(query.folderId==='root'?null:query.folderId)}
    if(query.scopeId){s.where.push(`${s.scope}=?`);s.params.push(query.scopeId)}
    if(query.q){s.where.push(`(${s.search}) LIKE ? ESCAPE '\\'`);s.params.push(`%${query.q.replace(/[\\%_]/g,'\\$&')}%`)}
    if(query.filter){
      if(!s.filters[query.filter])return reply.code(400).send(fail(4001,'筛选条件无效'))
      s.where.push(s.filters[query.filter])
    }
    const where=s.where.join(' AND ')
    const total=(db.prepare(`SELECT COUNT(*) AS n FROM ${s.from} WHERE ${where}`).get(...s.params) as {n:number}).n
    const offset=(query.page-1)*query.size
    let folderTotal=0
    let folders:Record<string,unknown>[]=[]
    if(browsing&&!query.q){
      const folderWhere=['df.parent_id IS ?',`df.scope_id IN (${ctx.scopeIds.map(()=>'?').join(',')||'NULL'})`]
      const params:unknown[]=[query.folderId==='root'?null:query.folderId,...ctx.scopeIds]
      if(query.scopeId){folderWhere.push('df.scope_id=?');params.push(query.scopeId)}
      const clause=folderWhere.join(' AND ')
      folderTotal=(db.prepare(`SELECT COUNT(*) AS n FROM document_folders df WHERE ${clause}`).get(...params) as {n:number}).n
      folders=db.prepare(`SELECT df.id,df.name,df.parent_id AS parentId,df.scope_id AS scopeId,s.name AS scopeName,s.kind AS scopeKind FROM document_folders df JOIN v_effective_scopes s ON s.id=df.scope_id WHERE ${clause} ORDER BY df.name,df.id LIMIT ? OFFSET ?`).all(...params,query.size,offset) as Record<string,unknown>[]
    }
    const rows=db.prepare(`SELECT ${s.select} FROM ${s.from} WHERE ${where} ORDER BY ${s.order} LIMIT ? OFFSET ?`)
      .all(...s.params,query.size-folders.length,Math.max(0,offset-folderTotal)) as Record<string,unknown>[]
    const pathCache=new Map<string,string>()
    const items=rows.map(row=>{
      if(query.resource==='documents'){
        const id=row.folderId as string|null
        if(id&&!pathCache.has(id))pathCache.set(id,folderBreadcrumbs(db,id).map(folder=>folder.name).join('/'))
        row.folderPath=id?pathCache.get(id):''
      }
      return hydrate(query.resource as Resource,row)
    })
    return reply.send(ok({items,total:total+folderTotal,page:query.page,size:query.size,
      ...(browsing?{supportsFolders:true,folders,breadcrumbs,documentTotal:total,folderTotal}:{})}))
  })
}
