import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, type DB } from '../src/db/index.js'
import { buildApp } from '../src/app.js'
import { testConfig } from '../src/config.js'
import { createUser } from '../src/dao/users.js'
import { createDocumentFamily } from '../src/dao/documents.js'
import { ensureOrgScope } from '../src/server.js'

let app:FastifyInstance,db:DB,temp:string,admin:string,member:string,adminId:string,memberId:string,org:string
const headers=(token=admin)=>({authorization:`Bearer ${token}`})
beforeEach(async()=>{
 temp=await mkdtemp(join(tmpdir(),'echo-administration-'))
 db=openDb({path:':memory:'});ensureOrgScope(db)
 adminId=(await createUser(db,{username:'admin',password:'test-password',role:'admin',clearance:2})).id
 memberId=(await createUser(db,{username:'member',password:'test-password',clearance:0})).id
 org=(db.prepare("SELECT id FROM scopes WHERE kind='org'").get() as any).id
 app=buildApp({db,cfg:testConfig({storageDir:temp,chatModel:'test-chat',chatKey:'test-only-upstream-key',chatBaseUrl:'https://test-model.invalid/v1'}),serveWeb:false})
 const login=async(username:string)=>(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username,password:'test-password',deviceId:`device-${username}`}})).json().data.accessToken
 admin=await login('admin');member=await login('member')
})
afterEach(async()=>{vi.unstubAllGlobals();await app.close();db.close();await rm(temp,{recursive:true,force:true})})
function rejected(id:string,scope=org){db.prepare(`INSERT INTO document_submissions(id,submitter_id,target_scope,title,source_type,storage_key,content_hash,state,scan_status,scan_report_json,created_at)
 VALUES(?,?,?,'Risk document','txt','quarantine/test.txt',?,'rejected','failed',?,1)`).run(id,memberId,scope,id,JSON.stringify({status:'failed',findings:[{code:'TEST_RISK',severity:'high',message:'风险已阻止'}],engines:[]}))}
function document(id:string,scope=org){const family=createDocumentFamily(db,{scopeId:scope,title:`制度 ${id}`,ownerId:adminId});db.prepare(`INSERT INTO documents(id,scope_id,title,source_type,content_hash,status,family_id,owner_id,fts_status,vector_status,created_at,updated_at)
 VALUES(?,?,'报销制度','txt',?,'ready',?,?,'ready','ready',1,1)`).run(id,scope,id,family,adminId);db.prepare('UPDATE document_families SET current_document_id=? WHERE id=?').run(id,family);return family}
describe('administrator product workflows',()=>{
 it('keeps private and above-clearance assets out of all quality document summaries and contribution counts',async()=>{
  document('shared-quality');document('private-quality',`personal-${memberId}`);document('secret-quality')
  db.prepare("UPDATE documents SET sensitivity=2 WHERE id='secret-quality'").run()
  db.prepare('UPDATE users SET clearance=0 WHERE id=?').run(adminId)
  const response=await app.inject({url:'/api/v1/admin/quality/overview',headers:headers()})
  expect(response.statusCode).toBe(200)
  const quality=response.json().data
  expect(quality.unusedDocs.map((x:any)=>x.id)).toEqual(['shared-quality'])
  expect(quality.docStats).toEqual([{status:'ready',n:1}])
  expect(quality.contributions).toHaveLength(1)
  expect(quality.contributions[0].documents).toBe(1)
 })

 it('treats a historical rejected risk as isolated rather than a permanent todo; dispositions never publish it',async()=>{
  rejected('risk')
  let result=(await app.inject({url:'/api/v1/admin/security-checks?view=attention',headers:headers()})).json().data
  expect(result.items).toEqual([]);expect(result.summary).toMatchObject({failed:1,isolated:1,attention:0})
  const dispose=(status:string)=>app.inject({method:'POST',url:'/api/v1/admin/security-checks/document/risk/disposition',headers:headers(),payload:{status,note:'已核对安全处置'}})
  expect((await dispose('follow_up')).statusCode).toBe(200)
  result=(await app.inject({url:'/api/v1/admin/workspace',headers:headers()})).json().data
  expect(result.operations.safetyFailed).toBe(1)
  expect((await dispose('archived')).statusCode).toBe(200)
  result=(await app.inject({url:'/api/v1/admin/security-checks?view=archived',headers:headers()})).json().data
  expect(result.items[0].state).toBe('rejected');expect(result.summary.attention).toBe(0)
  expect((db.prepare("SELECT state,scan_status FROM document_submissions WHERE id='risk'").get())).toEqual({state:'rejected',scan_status:'failed'})
 })
 it('protects private records and in-flight automatic checks from disposition changes',async()=>{
  rejected('private',`personal-${memberId}`);rejected('pending')
  db.prepare("UPDATE document_submissions SET state='pending',auto_retry_at=? WHERE id='pending'").run(Date.now()+60000)
  const change=(id:string,token=admin)=>app.inject({method:'POST',url:`/api/v1/admin/security-checks/document/${id}/disposition`,headers:headers(token),payload:{status:'archived',note:'不得改变隔离'}})
  expect((await change('private')).statusCode).toBe(404)
  expect((await change('pending')).statusCode).toBe(409)
  expect((await change('pending',member)).statusCode).toBe(403)
  expect((await app.inject({url:'/api/v1/admin/security-checks?view=attention',headers:headers()})).json().data.total).toBe(1)
 })
 it('provides a sanitized member overview without exposing private knowledge or credential secrets',async()=>{
  const key=(await app.inject({method:'POST',url:'/api/v1/api-keys',headers:headers(member),payload:{name:'member device'}})).json().data
  const response=await app.inject({url:`/api/v1/admin/users/${memberId}/overview`,headers:headers()})
  expect(response.statusCode).toBe(200)
  const data=response.json().data
  expect(data.user.id).toBe(memberId);expect(data.keys.map((k:any)=>k.id)).toContain(key.id)
  expect(data.scopes.every((x:any)=>x.kind!=='personal')).toBe(true)
  expect(response.body).not.toContain(key.key);expect(response.body).not.toMatch(/password_hash|key_enc|key_hash|refresh_token/)
  expect(data.coverage).toMatchObject({reported:0,receipts:0})
  expect((await app.inject({url:`/api/v1/admin/users/${adminId}/overview`,headers:headers(member)})).statusCode).toBe(403)
  expect((await app.inject({url:'/api/v1/api-keys?userId=other',headers:headers(member)})).json().data.items).toHaveLength(1)
 })
 it('keeps unknown token amounts out of rankings and shows collection and accounting coverage',async()=>{
  db.prepare(`INSERT INTO model_calls(id,user_id,source,model,protocol,started_at,outcome,accounting_state) VALUES('unknown',?,'embedding','embed','chat',?,'failed','unknown')`).run(memberId,Date.now()-1000)
  const data=(await app.inject({url:'/api/v1/usage?state=unsettled',headers:headers()})).json().data
  expect(data.summary.calls).toBe(1);expect(data.rankings).toEqual([])
  expect(data.coverage).toEqual({total:1,complete:0,known:0});expect(data.collectionStartedAt).toBeGreaterThan(0)
  expect(data.items[0].totalTokens).toBeNull()
  for(const [id,name,tokens] of [['old-name','旧用户名',100],['new-name','新用户名',200]] as const)db.prepare(`INSERT INTO model_calls(id,user_id,user_name,source,model,protocol,started_at,outcome,accounting_state,total_tokens) VALUES(?,?,?,'desktop_chat','chat','chat',?,'succeeded','complete',?)`).run(id,memberId,name,Date.now(),tokens)
  const ranking=(await app.inject({url:'/api/v1/usage',headers:headers()})).json().data.rankings
  expect(ranking).toHaveLength(1);expect(ranking[0]).toMatchObject({userId:memberId,totalTokens:300,calls:3})
 })
 it('binds actual connection results to the saved revision and invalidates the badge on configuration changes',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'OK'}}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}}),{headers:{'content-type':'application/json'}})))
  const test=await app.inject({method:'POST',url:'/api/v1/admin/model-config/test',headers:headers()})
  expect(test.statusCode).toBe(200);expect(test.json().data.success).toBe(true)
  let config=(await app.inject({url:'/api/v1/model-config',headers:headers()})).json().data
  expect(config.connectionCheck).toMatchObject({success:1,httpStatus:200})
  const update=await app.inject({method:'PUT',url:'/api/v1/admin/model-config',headers:headers(),payload:{chatProvider:'openai-compatible',chatModel:'test-chat-new',embedModel:'test-embed',embedDim:1024}})
  expect(update.statusCode).toBe(200)
  config=(await app.inject({url:'/api/v1/model-config',headers:headers()})).json().data
  expect(config.connectionCheck).toBeNull()
  expect((db.prepare('SELECT COUNT(*) AS n FROM model_connection_checks').get() as any).n).toBe(1)
 })
 it('does not label malformed upstream success responses as a working connection',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({choices:[],usage:{prompt_tokens:1,completion_tokens:0,total_tokens:1}}),{headers:{'content-type':'application/json'}})))
  expect((await app.inject({method:'POST',url:'/api/v1/admin/model-config/test',headers:headers()})).json().data.success).toBe(false)
 })
 it('assigns maintenance only to enabled administrators and validates linked shared assets',async()=>{
  expect((await app.inject({method:'POST',url:'/api/v1/admin/maintenance',headers:headers(),payload:{question:'如何报销？',ownerId:memberId}})).statusCode).toBe(400)
  const task=(await app.inject({method:'POST',url:'/api/v1/admin/maintenance',headers:headers(),payload:{question:'如何报销？'}})).json().data
  let record=(await app.inject({url:'/api/v1/admin/maintenance',headers:headers()})).json().data[0]
  expect(record.owner_id).toBe(adminId);expect(record.ownerCanManage).toBe(1)
  const patch=(asset:string)=>app.inject({method:'PATCH',url:`/api/v1/admin/maintenance/${task.id}`,headers:headers(),payload:{version:1,state:'working',note:'正在补充材料',resultAssetId:asset,resultAssetKind:'document'}})
  document('private-doc',`personal-${memberId}`)
  expect((await patch('private-doc')).statusCode).toBe(400)
  document('shared-doc');expect((await patch('shared-doc')).statusCode).toBe(200)
  record=(await app.inject({url:'/api/v1/admin/maintenance',headers:headers()})).json().data[0]
  expect(record.resultAsset.title).toBe('报销制度')
  const picker=(await app.inject({url:'/api/v1/admin/knowledge-assets?q=报销',headers:headers()})).json().data
  expect(picker.map((x:any)=>x.id)).toEqual(['shared-doc'])
 })
 it('records actual retrieval retests with a version check and keeps a missed match distinct from verification',async()=>{
  document('shared-doc')
  const task=(await app.inject({method:'POST',url:'/api/v1/admin/maintenance',headers:headers(),payload:{question:'如何报销？'}})).json().data
  vi.spyOn(app.deps.retriever,'retrieve').mockResolvedValue({chunks:[],memories:[],diagnostics:{bm25Hits:0,vecHits:0,fusedCandidates:0,rerankMs:0,rerankSkipped:false,totalMs:2}} as any)
  const request={method:'POST' as const,url:`/api/v1/admin/maintenance/${task.id}/retest`,headers:headers(),payload:{version:1,assetId:'shared-doc',assetKind:'document'}}
  const response=await app.inject(request)
  expect(response.json().data).toMatchObject({matched:false,version:2,method:'retrieval'})
  expect((await app.inject(request)).statusCode).toBe(409)
  const record=(await app.inject({url:'/api/v1/admin/maintenance',headers:headers()})).json().data[0]
  expect(record.state).toBe('open');expect(record.verification.matched).toBe(false)
 })
 it('records partial skill receipts and distinguishes their timestamp from ordinary heartbeat contact',async()=>{
  const response=await app.inject({method:'POST',url:'/api/v1/client/heartbeat',headers:headers(member),payload:{capabilities:['skill-installation-receipts-v1'],skillsComplete:false,skills:[{skillId:'skill',versionId:'version',name:'知识复核',version:'1.0.0',state:'failed',error:'包校验失败'}]}})
  expect(response.statusCode).toBe(200)
  const first=(await app.inject({url:'/api/v1/admin/devices',headers:headers()})).json().data.items.find((x:any)=>x.userId===memberId)
  expect(first.skillReceiptsComplete).toBe(0);expect(first.skillReceiptAt).toBeGreaterThan(0)
  await app.inject({method:'POST',url:'/api/v1/client/heartbeat',headers:headers(member),payload:{version:'0.3.11'}})
  const second=(await app.inject({url:'/api/v1/admin/devices',headers:headers()})).json().data.items.find((x:any)=>x.userId===memberId)
  expect(second.skillReceiptAt).toBe(first.skillReceiptAt);expect(JSON.parse(second.receiptJson)[0].name).toBe('知识复核')
 })
 it('reports sparse quality samples and uses automatic-publication wording in notifications',async()=>{
  const quality=(await app.inject({url:'/api/v1/admin/quality/overview',headers:headers()})).json().data
  expect(quality.sample).toEqual({questions:0,feedback:0,limited:true,firstObservedAt:null})
  rejected('pending');db.prepare("UPDATE document_submissions SET state='pending' WHERE id='pending'").run()
  const notifications=await app.inject({url:'/api/v1/notifications',headers:headers()})
  expect(notifications.statusCode).toBe(200);expect(notifications.body).not.toContain('等待审核');expect(notifications.body).toContain('自动检查')
 })
 it('deduplicates open maintenance and records no-action closure without pretending a retest passed',async()=>{
  const create=()=>app.inject({method:'POST',url:'/api/v1/admin/maintenance',headers:headers(),payload:{question:'重复的待维护问题'}})
  const first=(await create()).json().data,second=(await create()).json().data
  expect(second).toEqual({id:first.id,dedup:true})
  const dismissed=await app.inject({method:'POST',url:`/api/v1/admin/maintenance/${first.id}/dismiss`,headers:headers(),payload:{version:1,note:'已确认属于重复反馈，无需补充材料'}})
  expect(dismissed.statusCode).toBe(200)
  const task=(await app.inject({url:'/api/v1/admin/maintenance',headers:headers()})).json().data[0]
  expect(task).toMatchObject({state:'closed',closure_reason:'no_action',verification:null})
  expect((await app.inject({url:'/api/v1/admin/workspace',headers:headers()})).json().data.operations.openMaintenance).toBe(0)
 })
 it('allows document handover only to a maintainer who can access the target scope and updates the family',async()=>{
  const team=(await app.inject({method:'POST',url:'/api/v1/admin/groups',headers:headers(),payload:{name:'研发'}})).json().data
  const family=document('handover',team.scopeId)
  const change=()=>app.inject({method:'PATCH',url:'/api/v1/docs/handover',headers:headers(),payload:{ownerId:memberId,ifUnmodifiedSince:1}})
  expect((await change()).statusCode).toBe(400)
  db.prepare('INSERT INTO user_groups(user_id,group_id) VALUES(?,?)').run(memberId,team.id)
  expect((await change()).statusCode).toBe(200)
  expect((db.prepare('SELECT owner_id FROM document_families WHERE id=?').get(family) as any).owner_id).toBe(memberId)
  expect((db.prepare("SELECT owner_id FROM documents WHERE id='handover'").get() as any).owner_id).toBe(memberId)
 })
})
