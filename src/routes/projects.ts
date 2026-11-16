import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthedRequest } from '../auth/jwt.js'
import { ok, fail } from '../reply.js'
import { createDocumentFamily } from '../dao/documents.js'
import { enqueueIngest } from '../kb/ingest/worker.js'
import { sourceTypeFromName } from '../kb/ingest/parse.js'
import { sourceCapabilityError } from '../kb/ingest/capabilities.js'
import { scanDocument } from '../security/content-scanner.js'
import { canAccessDocument, loadAccessContext } from '../auth/scopes.js'
import { documentIsCurrent } from '../dao/documents.js'
import type { RetrievedChunk } from '../kb/retrieve/index.js'
import { evidenceFromChunks, fallbackPlan, generateAnswerDraft, renderClaims, verifyClaims } from '../kb/agentic.js'

const Revision = z.number().int().positive()
const TaskInput = z.object({
 title: z.string().trim().min(1).max(300), description: z.string().max(12000).default(''),
 acceptance: z.string().max(4000).default(''), assigneeId: z.string().nullable().default(null)
}).strict()
const TaskPatch = TaskInput.partial().extend({
 expectedRevision: Revision,
 status: z.enum(['pending','in_progress','blocked','review','accepted']).optional()
}).strict()
const DecisionInput = z.object({
 content: z.string().trim().min(1).max(8000), rationale: z.string().max(8000).default(''),
 sourceTaskId: z.string().nullable().default(null), sourceDocumentId: z.string().nullable().default(null)
}).strict()
type Project = { id: string; scopeId: string; name: string; goal: string; ownerId: string; revision: number; updatedAt: number }
type Role = 'admin' | 'collaborator' | 'viewer'
class ProjectError extends Error { constructor(readonly status: number, message: string) { super(message) } }

export function registerProjectRoutes(app: FastifyInstance): void {
 const { db, cfg, storage } = app.deps
 const actor = (req: FastifyRequest) => (req as AuthedRequest).claims.sub
 const pid = (req: FastifyRequest) => (req.params as { projectId: string }).projectId
 const project = (id: string, userId: string, write = false, admin = false): Project & { role: Role } => {
  const row = db.prepare(`SELECT p.id,p.scope_id AS scopeId,p.name,p.goal,p.owner_id AS ownerId,p.revision,p.updated_at AS updatedAt,m.role
   FROM projects p JOIN project_members m ON m.project_id=p.id JOIN users u ON u.id=m.user_id AND u.status='active'
   WHERE p.id=? AND m.user_id=?`).get(id,userId) as (Project & { role: Role }) | undefined
  if (!row) throw new ProjectError(404,'项目不存在或已失去成员权限')
  if ((write && row.role==='viewer') || (admin && row.role!=='admin')) throw new ProjectError(403,'当前项目角色无权执行此操作')
  return row
 }
 // Legacy organization authoring endpoints must not turn a project viewer's
 // organization-wide curator/admin role into project write authority. Reading
 // still uses the existing live scope checks; project collaborators write via
 // project endpoints, while generic asset administration requires project admin.
 app.addHook('preHandler',async(req,reply)=>{
  const path=req.url.split('?')[0]
  if(['GET','HEAD','OPTIONS'].includes(req.method)||path.startsWith('/api/v1/projects')||
   ['/api/v1/docs/fetch','/api/v1/knowledge/ask','/api/v1/knowledge/context','/api/v1/retrieve','/mcp'].includes(path))return
  const scopes=new Set<string>()
  if(req.body&&typeof req.body==='object')for(const key of ['scopeId','targetScope','targetScopeId','mergedScopeId']){
   const value=(req.body as Record<string,unknown>)[key];if(typeof value==='string')scopes.add(value)
  }
  const resource=/^\/api\/v1\/(docs|memories|promotions|document-submissions)\/([^/]+)/.exec(path)
  if(resource){
   const tables:Record<string,[string,string]>={docs:['documents','scope_id'],memories:['org_memories','scope_id'],promotions:['promotions','target_scope'],'document-submissions':['document_submissions','target_scope']}
   const [table,column]=tables[resource[1]]
   const row=db.prepare(`SELECT ${column} AS scopeId FROM ${table} WHERE id=?`).get(decodeURIComponent(resource[2])) as {scopeId:string}|undefined
   if(row)scopes.add(row.scopeId)
  }
  for(const scope of scopes){
   const target=db.prepare('SELECT id FROM projects WHERE scope_id=?').get(scope) as {id:string}|undefined
   if(!target)continue
   if(!(req as AuthedRequest).claims){await app.authenticate(req,reply);if(reply.sent)return}
   try{project(target.id,actor(req),true,true)}catch(error){
    if(error instanceof ProjectError)return reply.code(error.status).send(fail(error.status*10,error.message))
    throw error
   }
  }
 })
 const event = (p: Project, userId: string, kind: string, resource: string) => {
  const now=Date.now()
  db.prepare('UPDATE projects SET revision=revision+1,updated_at=? WHERE id=?').run(now,p.id)
  db.prepare('INSERT INTO project_events VALUES (?,?,?,?,?,?)').run(randomUUID(),p.id,userId,kind,resource,now)
 }
 const member = (p: Project, id: string | null) => {
  if (id && !db.prepare("SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id AND u.status='active' WHERE project_id=? AND user_id=?").get(p.id,id))
   throw new ProjectError(400,'负责人必须是有效项目成员')
 }
 const snapshot = (p: Project, userId: string) => {
  const clearance=(db.prepare('SELECT clearance FROM users WHERE id=?').get(userId) as {clearance:number}).clearance
  return {
   ...p,
   runs:db.prepare(`SELECT id,task_id AS taskId,actor_id AS actorId,session_id AS sessionId,status,model_id AS modelId,
    expert_name AS expertName,expert_version AS expertVersion,summary,updated_at AS updatedAt FROM project_runs WHERE project_id=? ORDER BY updated_at DESC LIMIT 100`).all(p.id),
   members:db.prepare(`SELECT m.user_id AS userId,u.username,u.display_name AS displayName,m.role,m.joined_at AS joinedAt,u.status
    FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.joined_at,m.user_id`).all(p.id),
   tasks:db.prepare(`SELECT t.id,t.title,t.description,t.acceptance,t.assignee_id AS assigneeId,u.display_name AS assigneeName,t.status,t.revision,t.updated_at AS updatedAt
    FROM project_tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE project_id=? ORDER BY t.created_at,t.id LIMIT 500`).all(p.id),
   decisions:db.prepare(`SELECT id,content,rationale,status,source_task_id AS sourceTaskId,source_document_id AS sourceDocumentId,supersedes_id AS supersedesId,
    confirmed_by AS confirmedBy,revision,updated_at AS updatedAt FROM project_decisions WHERE project_id=? ORDER BY created_at DESC,id LIMIT 500`).all(p.id),
   assets:db.prepare(`SELECT d.id,d.family_id AS familyId,d.title,d.version,d.status,d.fail_reason AS failReason,d.fts_status AS ftsStatus,d.vector_status AS vectorStatus,
    d.byte_size AS byteSize,d.updated_at AS updatedAt,f.current_document_id AS currentDocumentId
    FROM documents d JOIN document_families f ON f.id=d.family_id WHERE d.scope_id=? AND d.sensitivity<=? AND f.state='active'
    AND d.id=(SELECT x.id FROM documents x WHERE x.family_id=f.id AND x.status!='archived' ORDER BY version DESC,created_at DESC,id DESC LIMIT 1)
    ORDER BY d.updated_at DESC LIMIT 500`).all(p.scopeId,clearance),
   events:db.prepare(`SELECT e.id,e.kind,e.resource_id AS resourceId,e.created_at AS createdAt,u.display_name AS actorName
    FROM project_events e JOIN users u ON u.id=e.actor_id WHERE project_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT 100`).all(p.id)
  }
 }
 const route = (method:'GET'|'POST'|'PATCH'|'DELETE',url:string,handler:(req:FastifyRequest)=>unknown|Promise<unknown>) => {
  app.route({method,url,preHandler:app.authenticate,handler:async(req,reply)=>{
   try { return reply.send(ok(await handler(req))) }
   catch(e) {
    if(e instanceof ProjectError) return reply.code(e.status).send(fail(e.status*10,e.message))
    if(e instanceof z.ZodError) return reply.code(400).send(fail(4001,'项目请求参数不合法'))
    throw e
   }
  }})
 }
 route('GET','/api/v1/projects',req=>db.prepare(`SELECT p.id,p.name,p.goal,p.scope_id AS scopeId,p.owner_id AS ownerId,p.revision,p.updated_at AS updatedAt,m.role
  FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.updated_at DESC LIMIT 500`).all(actor(req)))
 route('POST','/api/v1/projects',req=>{
  const input=z.object({name:z.string().trim().min(1).max(120),goal:z.string().max(12000).default('')}).strict().parse(req.body)
  const id=randomUUID(),scopeId=randomUUID(),now=Date.now(),userId=actor(req)
  db.transaction(()=>{
   db.prepare("INSERT INTO scopes(id,kind,name) VALUES (?,'team',?)").run(scopeId,input.name)
   db.prepare('INSERT INTO projects(id,scope_id,name,goal,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,scopeId,input.name,input.goal,userId,now,now)
   db.prepare("INSERT INTO project_members VALUES (?,?,'admin',?)").run(id,userId,now)
   app.audit(req,'project_create',id,{scopeId})
  })()
  return snapshot(project(id,userId),userId)
 })
 route('GET','/api/v1/projects/:projectId',req=>snapshot(project(pid(req),actor(req)),actor(req)))
 route('PATCH','/api/v1/projects/:projectId',req=>{
  const p=project(pid(req),actor(req),true,true)
  const input=z.object({name:z.string().trim().min(1).max(120),goal:z.string().max(12000),expectedRevision:Revision}).strict().parse(req.body)
  db.transaction(()=>{
   const result=db.prepare('UPDATE projects SET name=?,goal=? WHERE id=? AND revision=?').run(input.name,input.goal,p.id,input.expectedRevision)
   if(!result.changes)throw new ProjectError(409,'项目已更新，请刷新后重试')
   db.prepare('UPDATE scopes SET name=? WHERE id=?').run(input.name,p.scopeId)
   event(p,actor(req),'project_updated',p.id)
  })()
  return snapshot(project(p.id,actor(req)),actor(req))
 })
 route('POST','/api/v1/projects/:projectId/members',req=>{
  const p=project(pid(req),actor(req),true,true)
  const input=z.object({username:z.string().trim().min(1).max(120),role:z.enum(['admin','collaborator','viewer'])}).strict().parse(req.body)
  const user=db.prepare("SELECT id FROM users WHERE username=? AND status='active'").get(input.username) as {id:string}|undefined
  if(!user)throw new ProjectError(404,'未找到有效的组织成员')
  db.transaction(()=>{
   if(db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?').get(p.id,user.id))throw new ProjectError(409,'该成员已在项目中')
   db.prepare('INSERT INTO project_members VALUES (?,?,?,?)').run(p.id,user.id,input.role,Date.now())
   event(p,actor(req),'member_added',user.id);app.audit(req,'project_invite',p.id,{userId:user.id,role:input.role})
  })()
  return snapshot(project(p.id,actor(req)),actor(req))
 })
 route('DELETE','/api/v1/projects/:projectId/members/:userId',req=>{
  const p=project(pid(req),actor(req),true,true),{userId}=req.params as {userId:string}
  if(userId===p.ownerId)throw new ProjectError(409,'项目负责人不能被移除')
  db.transaction(()=>{
   db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(p.id,userId)
   event(p,actor(req),'member_removed',userId);app.audit(req,'project_remove_member',p.id,{userId})
  })()
  return {removed:true}
 })
 route('POST','/api/v1/projects/:projectId/tasks',req=>{
  const p=project(pid(req),actor(req),true),input=TaskInput.parse(req.body),id=randomUUID(),now=Date.now()
  member(p,input.assigneeId)
  if((db.prepare('SELECT count(*) AS n FROM project_tasks WHERE project_id=?').get(p.id) as {n:number}).n>=500)throw new ProjectError(409,'项目工作项已达到上限')
  db.transaction(()=>{
   db.prepare(`INSERT INTO project_tasks(id,project_id,title,description,acceptance,assignee_id,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,p.id,input.title,input.description,input.acceptance,input.assigneeId,actor(req),actor(req),now,now)
   event(p,actor(req),'task_created',id)
  })()
  return {id}
 })
 route('PATCH','/api/v1/projects/:projectId/tasks/:taskId',req=>{
  const p=project(pid(req),actor(req),true),{taskId}=req.params as {taskId:string},input=TaskPatch.parse(req.body)
  if(input.status==='accepted'&&p.role!=='admin')throw new ProjectError(403,'请由项目管理员验收工作项')
  if(input.assigneeId!==undefined)member(p,input.assigneeId)
  const {expectedRevision,...changes}=input
  const columns:Record<string,string>={title:'title',description:'description',acceptance:'acceptance',assigneeId:'assignee_id',status:'status'}
  const entries=Object.entries(changes)
  db.transaction(()=>{
   const result=db.prepare(`UPDATE project_tasks SET ${entries.map(([k])=>`${columns[k]}=?`).concat(['revision=revision+1','updated_at=?','updated_by=?']).join(',')}
    WHERE id=? AND project_id=? AND revision=?`).run(...entries.map(([,v])=>v),Date.now(),actor(req),taskId,p.id,expectedRevision)
   if(!result.changes)throw new ProjectError(409,'工作项已变更，请刷新后重试')
   event(p,actor(req),'task_updated',taskId)
  })()
  return {updated:true}
 })
 route('POST','/api/v1/projects/:projectId/tasks/:taskId/claim',req=>{
  const p=project(pid(req),actor(req),true),{taskId}=req.params as {taskId:string}
  const input=z.object({expectedRevision:Revision}).strict().parse(req.body)
  db.transaction(()=>{
   const result=db.prepare("UPDATE project_tasks SET assignee_id=?,status='in_progress',revision=revision+1,updated_by=?,updated_at=? WHERE id=? AND project_id=? AND revision=? AND status!='accepted'")
    .run(actor(req),actor(req),Date.now(),taskId,p.id,input.expectedRevision)
   if(!result.changes)throw new ProjectError(409,'工作项已被更新或已验收，请刷新后接手')
   event(p,actor(req),'task_claimed',taskId)
  })()
  return snapshot(project(p.id,actor(req)),actor(req))
 })
 route('POST','/api/v1/projects/:projectId/decisions',req=>{
  const p=project(pid(req),actor(req),true),input=DecisionInput.parse(req.body),id=randomUUID(),now=Date.now()
  if(input.sourceTaskId&&!db.prepare('SELECT 1 FROM project_tasks WHERE id=? AND project_id=?').get(input.sourceTaskId,p.id))throw new ProjectError(400,'决策来源工作项不属于当前项目')
  if(input.sourceDocumentId&&!db.prepare('SELECT 1 FROM documents WHERE id=? AND scope_id=? AND sensitivity<=(SELECT clearance FROM users WHERE id=?)').get(input.sourceDocumentId,p.scopeId,actor(req)))throw new ProjectError(400,'决策来源文档不可访问')
  if((db.prepare('SELECT count(*) AS n FROM project_decisions WHERE project_id=?').get(p.id) as {n:number}).n>=500)throw new ProjectError(409,'项目决策已达到上限')
  db.transaction(()=>{
   db.prepare(`INSERT INTO project_decisions(id,project_id,content,rationale,source_task_id,source_document_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id,p.id,input.content,input.rationale,input.sourceTaskId,input.sourceDocumentId,actor(req),now,now)
   event(p,actor(req),'decision_proposed',id)
  })()
  return {id}
 })
 route('POST','/api/v1/projects/:projectId/runs',req=>{
  const p=project(pid(req),actor(req),true)
  const input=z.object({runId:z.string().uuid(),taskId:z.string().uuid(),sessionId:z.string().uuid(),status:z.enum(['running','completed','failed','cancelled']),
   modelId:z.string().max(500).optional(),expertName:z.string().max(256).optional(),expertVersion:z.string().max(128).optional(),summary:z.string().max(12000).default('')}).strict().parse(req.body)
  db.transaction(()=>{
   const existing=db.prepare('SELECT project_id AS projectId,actor_id AS actorId,session_id AS sessionId,task_id AS taskId,status FROM project_runs WHERE id=?').get(input.runId) as {projectId:string;actorId:string;sessionId:string;taskId:string;status:string}|undefined
   if(existing){
    if(existing.projectId!==p.id||existing.actorId!==actor(req)||existing.sessionId!==input.sessionId||existing.taskId!==input.taskId)throw new ProjectError(409,'运行记录身份不匹配')
    if(existing.status!=='running'||input.status==='running')return
    db.prepare('UPDATE project_runs SET status=?,summary=?,updated_at=? WHERE id=?').run(input.status,input.summary,Date.now(),input.runId)
    // A late result from a previous owner cannot overwrite a newly claimed or accepted task.
    db.prepare(`UPDATE project_tasks SET status=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=? AND project_id=? AND assignee_id=? AND status='in_progress'
     AND revision=(SELECT task_revision FROM project_runs WHERE id=?)`).run(input.status==='completed'?'review':'blocked',Date.now(),actor(req),input.taskId,p.id,actor(req),input.runId)
   } else {
    if(input.status!=='running')throw new ProjectError(409,'运行尚未登记，请重试同步')
    const task=db.prepare("SELECT revision FROM project_tasks WHERE id=? AND project_id=? AND assignee_id=? AND status IN ('in_progress','review','blocked')").get(input.taskId,p.id,actor(req)) as {revision:number}|undefined
    if(!task)throw new ProjectError(409,'工作项已移交或状态改变，请刷新后执行')
    // Every admitted execution owns a new task revision, including a follow-up
    // by the same person. An older turn can finish after a replacement starts.
    db.prepare("UPDATE project_tasks SET status='in_progress',revision=revision+1,updated_at=?,updated_by=? WHERE id=?").run(Date.now(),actor(req),input.taskId)
    db.prepare(`INSERT INTO project_runs(id,project_id,task_id,actor_id,session_id,status,task_revision,model_id,expert_name,expert_version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.runId,p.id,input.taskId,actor(req),input.sessionId,'running',task.revision+1,input.modelId??null,input.expertName??null,input.expertVersion??null,Date.now(),Date.now())
   }
   event(p,actor(req),'run_updated',input.runId)
  })()
  return {recorded:true}
 })
 route('PATCH','/api/v1/projects/:projectId/decisions/:decisionId',req=>{
  const p=project(pid(req),actor(req),true,true),{decisionId}=req.params as {decisionId:string}
  const input=z.object({expectedRevision:Revision,status:z.enum(['active','retired']),supersedesId:z.string().optional(),supersedesRevision:Revision.optional()}).strict().parse(req.body)
  db.transaction(()=>{
   if(input.supersedesId){
    if(input.status!=='active'||input.supersedesId===decisionId||!input.supersedesRevision)throw new ProjectError(400,'请提供被替代决策的当前版本')
    const previous=db.prepare("UPDATE project_decisions SET status='superseded',revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND status='active' AND revision=?")
     .run(Date.now(),input.supersedesId,p.id,input.supersedesRevision)
    if(!previous.changes)throw new ProjectError(409,'被替代决策已变更')
   }
   const result=db.prepare(`UPDATE project_decisions SET status=?,confirmed_by=?,supersedes_id=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=? AND status IN ('proposed','active')`)
    .run(input.status,actor(req),input.supersedesId??null,Date.now(),decisionId,p.id,input.expectedRevision)
   if(!result.changes)throw new ProjectError(409,'决策已变更，请刷新后重试')
   event(p,actor(req),'decision_updated',decisionId)
  })()
  return {updated:true}
 })
 route('POST','/api/v1/projects/:projectId/assets',async req=>{
  const p=project(pid(req),actor(req),true),data=await req.file()
  if(!data)throw new ProjectError(400,'请选择文件')
  const fields=data.fields as Record<string,{value?:string}>,name=data.filename,sourceType=sourceTypeFromName(name)
  if(!sourceType){data.file.resume();throw new ProjectError(415,'不支持此文件类型')}
  const buf=await data.toBuffer()
  if(data.file.truncated)throw new ProjectError(413,'文件超出上传限制')
  const capability=await sourceCapabilityError(sourceType,app.deps,buf.length)
  if(capability)throw new ProjectError(503,capability)
  const report=await scanDocument(buf,sourceType,cfg)
  if(report.status!=='passed')throw new ProjectError(422,'文档技术扫描未通过')
  project(p.id,actor(req),true)
  const storageKey=await storage.put(buf,name.split('.').pop()??'txt','published/documents')
  const docId=randomUUID(),now=Date.now(),family=fields.familyId?.value
  try { db.transaction(()=>{
   project(p.id,actor(req),true)
   let familyId=family,version=1,supersedes:string|null=null
   if(familyId){
    const f=db.prepare("SELECT current_document_id AS currentId FROM document_families WHERE id=? AND scope_id=? AND state='active'").get(familyId,p.scopeId) as {currentId:string|null}|undefined
    const latest=db.prepare('SELECT id,version FROM documents WHERE family_id=? ORDER BY version DESC LIMIT 1').get(familyId) as {id:string;version:number}|undefined
    if(!f||!latest||String(latest.version)!==fields.expectedVersion?.value)throw new ProjectError(409,'资料版本已变化，请刷新后重试')
    version=latest.version+1;supersedes=latest.id
   } else familyId=createDocumentFamily(db,{scopeId:p.scopeId,title:name,ownerId:actor(req),now})
   db.prepare(`INSERT INTO documents(id,scope_id,title,source_type,storage_key,content_hash,byte_size,owner_id,family_id,version,supersedes_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(docId,p.scopeId,name,sourceType,storageKey,createHash('sha256').update(buf).digest('hex'),buf.length,actor(req),familyId,version,supersedes,now,now)
   enqueueIngest(db,docId);event(p,actor(req),'asset_published',docId)
   app.audit(req,'project_asset_publish',docId,{projectId:p.id,version})
  })() } catch(e) {await storage.delete(storageKey);throw e}
  return {docId,status:'pending'}
 })
 route('POST','/api/v1/projects/:projectId/ask',async req=>{
  const p=project(pid(req),actor(req)),input=z.object({question:z.string().trim().min(1).max(8000),contextOnly:z.boolean().default(false)}).strict().parse(req.body)
  const state=snapshot(p,actor(req))
  const chunks:RetrievedChunk[]=[]
  const add=(id:string,title:string,text:string,kind:string)=>chunks.push({chunkId:id,docId:id,docTitle:title,text,score:1,scopeKind:'team',modality:'text',sourceType:kind,
   citation:{page:null,heading:title,startMs:null,endMs:null,openUrl:`/api/v1/projects/${p.id}`},owner:null,stale:false,updatedAt:p.updatedAt})
  add(p.id,p.name,`项目目标：${p.goal||'尚未填写'}。当前项目版本：${p.revision}；更新时间：${new Date(p.updatedAt).toISOString()}。`,'project')
  const labels:Record<string,string>={pending:'待开始',in_progress:'进行中',blocked:'阻塞',review:'待验收',accepted:'已验收'}
  for(const t of state.tasks as Array<{id:string;title:string;description:string;acceptance:string;assigneeName:string|null;status:string}>)
   add(t.id,t.title,`工作项：${t.title}；状态：${labels[t.status]}；负责人：${t.assigneeName??'未分配'}。${t.description}\n验收要求：${t.acceptance||'尚未填写'}`,'project_task')
  for(const d of state.decisions as Array<{id:string;content:string;rationale:string;status:string}>)if(d.status==='active')
   add(d.id,'已确认决策',`${d.content}\n理由：${d.rationale}`,'project_decision')
  for(const run of state.runs as Array<{id:string;taskId:string;status:string;summary:string;updatedAt:number}>)
   if(run.summary)add(run.id,'工作执行记录',`历史执行记录，时间：${new Date(run.updatedAt).toISOString()}；工作项 ${run.taskId} 的本轮状态：${run.status}。本轮结果：${run.summary}。这是执行者的报告，运行完成不代表验收通过；当前进展以最新工作项为准，当前结论以已确认决策为准。`,'project_run')
  const retrieved=await app.deps.retriever.retrieve(actor(req),{query:input.question,scopeIds:[p.scopeId],limit:8,tokenBudget:5000})
  chunks.push(...retrieved.chunks)
  // Bound generation, while the snapshot endpoint still exposes the full board.
  const candidates=[...chunks.filter(c=>c.sourceType==='project').slice(0,1),...retrieved.chunks,...chunks.filter(c=>c.sourceType==='project_decision'),...chunks.filter(c=>c.sourceType==='project_task'),...chunks.filter(c=>c.sourceType==='project_run')]
  let budget=32000
  const selected=candidates.slice(0,80).filter(chunk=>{if(budget<=0)return false;chunk.text=chunk.text.slice(0,Math.min(4000,budget));budget-=chunk.text.length;return true})
  const evidence=evidenceFromChunks(selected)
  const draft=input.contextOnly?null:await generateAnswerDraft(db,cfg,input.question,fallbackPlan(input.question,'fast'),evidence)
  let answer='',verification='extractive_fallback'
  if(draft&&!draft.insufficient&&draft.claims.length&&(await verifyClaims(db,cfg,input.question,[input.question],draft.claims,evidence)).valid){
   answer=renderClaims(draft.claims);verification='supported'
  } else answer=evidence.map(e=>`- ${e.text} [${e.citationId}]`).join('\n')
  const current=project(p.id,actor(req)) // Revocation during retrieval/generation must suppress the response.
  if(current.revision!==p.revision)throw new ProjectError(409,'项目在问答期间已更新，请刷新后重试')
  const access=loadAccessContext(db,actor(req))
  if(retrieved.chunks.some(chunk=>!canAccessDocument(db,access,chunk.docId)||!documentIsCurrent(db,chunk.docId)))throw new ProjectError(409,'引用资料的权限或有效版本已改变，请重新查询')
  const gaps:string[]=[]
  if(!p.goal)gaps.push('项目目标尚未填写')
  if(!state.tasks.length)gaps.push('尚无已记录的工作项')
  if(!(state.decisions as Array<{status:string}>).some(d=>d.status==='active'))gaps.push('尚无已确认决策')
  if((state.assets as Array<{status:string}>).some(a=>a.status!=='ready'))gaps.push('部分资料尚未完成索引；不会当作已读取依据')
  if(!retrieved.chunks.length)gaps.push('未检索到与问题匹配的项目文档；以下为已记录的项目事实，可能未完整回答问题')
  if(candidates.length>selected.length)gaps.push('项目记录较多，本次仅提供部分记录，请缩小问题或打开完整工作项查看')
  return {answer,verification,insufficient:verification!=='supported',projectRevision:p.revision,updatedAt:p.updatedAt,gaps,
   citations:evidence.map((e,i)=>({id:e.citationId,title:e.title,quote:e.text,resourceId:selected[i].docId,kind:selected[i].sourceType,openUrl:selected[i].citation.openUrl}))}
 })
}
