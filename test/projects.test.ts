import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { testConfig } from '../src/config.js'
import { createUser } from '../src/dao/users.js'
import { openDb, type DB } from '../src/db/index.js'
import { ensureOrgScope } from '../src/server.js'
import { drain } from '../src/kb/ingest/worker.js'
import { loadAccessContext, canPublishDocument } from '../src/auth/scopes.js'

let app:FastifyInstance,db:DB,dir:string
let tokens:Record<string,string>,ids:Record<string,string>
async function request(user:string,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown){
 return app.inject({method,url,headers:{authorization:`Bearer ${tokens[user]}`},payload:payload as never})
}
async function create(){return (await request('a','POST','/api/v1/projects',{name:'接口项目',goal:'完成接口建设和联调'})).json().data}
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'echo-projects-'));db=openDb({path:':memory:'});ensureOrgScope(db)
 ids={};tokens={};
 for(const name of ['a','b','c','outsider','orgadmin'])ids[name]=(await createUser(db,{username:name,password:'password-123',role:name==='orgadmin'?'admin':'member'})).id
 app=buildApp({db,cfg:testConfig({storageDir:dir}),serveWeb:false})
 for(const name of Object.keys(ids))tokens[name]=(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:name,password:'password-123',deviceId:`project-${name}`}})).json().data.accessToken
})
afterEach(async()=>{await app.close();db.close();rmSync(dir,{recursive:true,force:true})})
describe('team project ownership, grounded handoff and live scope authorization',()=>{
 it('shares idempotent project comments only with authorized members',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`,clientRequestId=crypto.randomUUID()
  await request('a','POST',`${base}/members`,{username:'b',role:'collaborator'})
  await request('a','POST',`${base}/members`,{username:'c',role:'viewer'})
  const input={content:'本周先完成需求访谈。',clientRequestId}
  const posted=(await request('b','POST',`${base}/comments`,input)).json().data
  expect((await request('b','POST',`${base}/comments`,input)).json().data.id).toBe(posted.id)
  expect((await request('c','GET',base)).json().data.comments).toMatchObject([{content:input.content,actorName:'b'}])
  expect((await request('c','POST',`${base}/comments`,{...input,clientRequestId:crypto.randomUUID()})).statusCode).toBe(403)
  expect((await request('outsider','GET',base)).statusCode).toBe(404)
  await request('a','DELETE',`${base}/members/${ids.b}`)
  expect((await request('b','POST',`${base}/comments`,input)).statusCode).toBe(404)
 })
 it('corrects and retires decisions without losing earlier versions or allowing stale writes',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`
  const id=(await request('a','POST',`${base}/decisions`,{content:'原决定',rationale:'原依据'})).json().data.id
  await request('a','PATCH',`${base}/decisions/${id}`,{expectedRevision:1,status:'active'})
  expect((await request('a','PATCH',`${base}/decisions/${id}`,{expectedRevision:2,content:'更正后的决定'})).statusCode).toBe(200)
  const decision=(await request('a','GET',base)).json().data.decisions[0]
  expect(decision).toMatchObject({content:'更正后的决定',rationale:'原依据',status:'active',revision:3})
  expect(decision.history).toHaveLength(2)
  expect(decision.history[0].content).toBe('原决定')
  expect((await request('a','PATCH',`${base}/decisions/${id}`,{expectedRevision:2,content:'过期覆盖'})).statusCode).toBe(409)
  await request('a','PATCH',`${base}/decisions/${id}`,{expectedRevision:3,status:'retired'})
  expect((await request('a','PATCH',`${base}/decisions/${id}`,{expectedRevision:4,status:'active'})).statusCode).toBe(200)
  await request('a','POST',`${base}/members`,{username:'b',role:'collaborator'})
  expect((await request('b','PATCH',`${base}/decisions/${id}`,{expectedRevision:5,content:'越权覆盖'})).statusCode).toBe(403)
 })
 it('A/B publish work; newly invited C can understand it, claim work and continue without their clients',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`
  expect((await request('a','POST',`${base}/members`,{username:'b',role:'collaborator'})).statusCode).toBe(200)
  const taskId=(await request('b','POST',`${base}/tasks`,{title:'接口联调',description:'接口设计已完成，等待联调',acceptance:'联调报告通过复核',assigneeId:ids.b})).json().data.id
  expect((await request('b','PATCH',`${base}/tasks/${taskId}`,{expectedRevision:1,status:'review'})).statusCode).toBe(200)
  const decisionId=(await request('b','POST',`${base}/decisions`,{content:'采用 REST 接口',rationale:'现有系统兼容',sourceTaskId:taskId})).json().data.id
  await request('a','PATCH',`${base}/decisions/${decisionId}`,{expectedRevision:1,status:'active'})
  expect((await request('c','GET',base)).statusCode).toBe(404)
  await request('a','POST',`${base}/members`,{username:'c',role:'collaborator'})
  const answer=await request('c','POST',`${base}/ask`,{question:'目前项目进展和当前决策是什么？'})
  expect(answer.statusCode).toBe(200)
  expect(answer.json().data.answer).toContain('待验收')
  expect(answer.json().data.answer).toContain('采用 REST 接口')
  expect(answer.json().data.citations.some((c:{resourceId:string})=>c.resourceId===taskId)).toBe(true)
  expect((await request('c','POST',`${base}/tasks/${taskId}/claim`,{expectedRevision:2})).json().data.tasks[0].assigneeId).toBe(ids.c)
  expect((await request('b','PATCH',`${base}/tasks/${taskId}`,{expectedRevision:2,status:'accepted'})).statusCode).toBe(403)
  expect((await request('b','POST',`${base}/tasks/${taskId}/claim`,{expectedRevision:2})).statusCode).toBe(409)
 })
 it('organization members and administrators do not implicitly inherit project content; removal invalidates generic knowledge scopes',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`
  expect(loadAccessContext(db,ids.orgadmin).scopeIds).not.toContain(p.scopeId)
  expect((await request('orgadmin','GET',base)).statusCode).toBe(404)
  await request('a','POST',`${base}/members`,{username:'c',role:'viewer'})
  expect(loadAccessContext(db,ids.c).scopeIds).toContain(p.scopeId)
  expect(canPublishDocument(db,loadAccessContext(db,ids.c),'member',p.scopeId)).toBe(false)
  expect((await request('c','POST',`${base}/tasks`,{title:'unauthorized'})).statusCode).toBe(403)
  expect((await request('c','POST',`${base}/members`,{username:'b',role:'admin'})).statusCode).toBe(403)
  expect((await request('a','DELETE',`${base}/members/${ids.a}`)).statusCode).toBe(409)
  await request('a','DELETE',`${base}/members/${ids.c}`)
  expect(loadAccessContext(db,ids.c).scopeIds).not.toContain(p.scopeId)
  expect((await request('c','POST',`${base}/ask`,{question:'项目进展'})).statusCode).toBe(404)
  expect((await request('c','GET',base)).statusCode).toBe(404)
 })
 it('confirms and supersedes decisions atomically, rejects stale updates and cross-project sources',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`
  const first=(await request('a','POST',`${base}/decisions`,{content:'旧方案'})).json().data.id
  await request('a','PATCH',`${base}/decisions/${first}`,{expectedRevision:1,status:'active'})
  const second=(await request('a','POST',`${base}/decisions`,{content:'当前方案'})).json().data.id
  expect((await request('a','PATCH',`${base}/decisions/${second}`,{expectedRevision:9,status:'active',supersedesId:first,supersedesRevision:2})).statusCode).toBe(409)
  expect((await request('a','GET',base)).json().data.decisions.find((d:{id:string})=>d.id===first).status).toBe('active')
  await request('a','PATCH',`${base}/decisions/${second}`,{expectedRevision:1,status:'active',supersedesId:first,supersedesRevision:2})
  const answer=(await request('a','POST',`${base}/ask`,{question:'当前方案'})).json().data
  expect(answer.answer).toContain('当前方案');expect(answer.answer).not.toContain('旧方案')
  const other=await create(),tid=(await request('a','POST',`/api/v1/projects/${other.id}/tasks`,{title:'其他项目工作'})).json().data.id
  expect((await request('a','POST',`${base}/decisions`,{content:'跨项目',sourceTaskId:tid})).statusCode).toBe(400)
  expect((await request('a','PATCH',base,{name:'覆盖',goal:'',expectedRevision:1})).statusCode).toBe(409)
 })
 it('publishes files through existing scan, ingestion, current-version retrieval and authorized download',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`
  async function upload(content:string,fields=''){
   const boundary='EchoProjectBoundary'
   return app.inject({method:'POST',url:`${base}/assets`,headers:{authorization:`Bearer ${tokens.a}`,'content-type':`multipart/form-data; boundary=${boundary}`},
    payload:Buffer.from(fields+`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="接口.md"\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--${boundary}--\r\n`)})
  }
  const uploaded=await upload('# 联调规范\n\n接口联调超时为三十秒。')
  expect(uploaded.statusCode).toBe(200)
  expect(typeof uploaded.json().data.familyId).toBe('string')
  expect((await request('a','GET',`/api/v1/docs/${uploaded.json().data.docId}/raw`)).statusCode).toBe(200)
  await drain(app.deps)
  const docId=uploaded.json().data.docId
  await request('a','POST',`${base}/members`,{username:'orgadmin',role:'viewer'})
  expect((await request('orgadmin','PATCH',`/api/v1/docs/${docId}`,{title:'越权修改'})).statusCode).toBe(403)
  expect((await request('orgadmin','POST','/api/v1/promotions',{targetScope:p.scopeId,payloadType:'memory',source:'manual',payload:{kind:'decision',content:'越权决策'}})).statusCode).toBe(403)
  await request('a','POST',`${base}/members`,{username:'c',role:'viewer'})
  const answer=(await request('c','POST',`${base}/ask`,{question:'接口联调超时是多少？'})).json().data
  expect(answer.citations.some((c:{resourceId:string})=>c.resourceId===docId)).toBe(true)
  expect((await request('c','GET',`/api/v1/docs/${docId}/raw`)).statusCode).toBe(200)
  expect((await request('outsider','GET',`/api/v1/docs/${docId}/raw`)).statusCode).toBe(404)
  const asset=(await request('a','GET',base)).json().data.assets[0]
  const fields=`--EchoProjectBoundary\r\nContent-Disposition: form-data; name="familyId"\r\n\r\n${asset.familyId}\r\n--EchoProjectBoundary\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n1\r\n`
  const next=await upload('# 联调规范\n\n接口联调超时为六十秒。',fields)
  expect(next.statusCode).toBe(200)
  expect(next.json().data.familyId).toBe(uploaded.json().data.familyId)
  expect((await upload('stale write',fields)).statusCode).toBe(409)
  const before=(await request('c','POST',`${base}/ask`,{question:'接口联调超时是多少？'})).json().data
  expect(before.citations.some((c:{resourceId:string})=>c.resourceId===docId)).toBe(true)
  expect(before.gaps).toContain('部分资料尚未完成索引；不会当作已读取依据')
  await drain(app.deps)
  const after=(await request('c','POST',`${base}/ask`,{question:'接口联调超时是多少？'})).json().data
  expect(after.citations.some((c:{resourceId:string})=>c.resourceId===next.json().data.docId)).toBe(true)
  expect(after.citations.some((c:{resourceId:string})=>c.resourceId===docId)).toBe(false)
  await request('a','DELETE',`${base}/members/${ids.c}`)
  expect((await request('c','GET',`/api/v1/docs/${docId}/raw`)).statusCode).toBe(404)
 })
 it('records execution idempotently, marks completion for review, and fences late results after C takes over',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`
  await request('a','POST',`${base}/members`,{username:'b',role:'collaborator'})
  await request('a','POST',`${base}/members`,{username:'c',role:'collaborator'})
  const taskId=(await request('b','POST',`${base}/tasks`,{title:'联调'})).json().data.id
  const claimed=(await request('b','POST',`${base}/tasks/${taskId}/claim`,{expectedRevision:1})).json().data
  const run={runId:randomUUID(),sessionId:randomUUID(),taskId,status:'running',modelId:'test-model',expertName:'接口专家',expertVersion:'v1'}
  expect((await request('b','POST',`${base}/runs`,run)).statusCode).toBe(200)
  expect((await request('b','POST',`${base}/runs`,run)).statusCode).toBe(200)
  await request('b','POST',`${base}/runs`,{...run,status:'completed',summary:'接口方案与联调报告已生成，等待验收'})
  let current=(await request('c','GET',base)).json().data
  expect(current.tasks[0].status).toBe('review');expect(current.runs).toHaveLength(1)
  expect((await request('c','POST',`${base}/ask`,{question:'联调报告是否完成？'})).json().data.answer).toContain('等待验收')
  await request('c','POST',`${base}/tasks/${taskId}/claim`,{expectedRevision:current.tasks[0].revision})
  await request('b','POST',`${base}/runs`,{...run,status:'failed',summary:'迟到的旧结果'})
  current=(await request('c','GET',base)).json().data
  expect(current.tasks[0].assigneeId).toBe(ids.c);expect(current.tasks[0].status).toBe('in_progress')
  expect(current.runs[0].status).toBe('completed')
  expect((await request('b','POST',`${base}/runs`,{...run,runId:randomUUID()})).statusCode).toBe(409)
  expect(claimed.tasks[0].status).toBe('in_progress')
 })
 it('a replacement execution by the same owner fences an older turn without duplicating admissions',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`
  const taskId=(await request('a','POST',`${base}/tasks`,{title:'修订接口方案'})).json().data.id
  await request('a','POST',`${base}/tasks/${taskId}/claim`,{expectedRevision:1})
  const first={runId:randomUUID(),sessionId:randomUUID(),taskId,status:'running'}
  await request('a','POST',`${base}/runs`,first)
  const started=(await request('a','GET',base)).json().data
  await request('a','POST',`${base}/runs`,first)
  expect((await request('a','GET',base)).json().data.tasks[0].revision).toBe(started.tasks[0].revision)
  const replacement={...first,runId:randomUUID()}
  await request('a','POST',`${base}/runs`,replacement)
  await request('a','POST',`${base}/runs`,{...first,status:'completed',summary:'旧回复'})
  expect((await request('a','GET',base)).json().data.tasks[0].status).toBe('in_progress')
  await request('a','POST',`${base}/runs`,{...replacement,status:'completed',summary:'修订后的结果'})
  expect((await request('a','GET',base)).json().data.tasks[0].status).toBe('review')
 })
 it('suppresses an in-flight answer when membership is revoked and rejects caller-controlled scope widening',async()=>{
  const p=await create(),base=`/api/v1/projects/${p.id}`
  await request('a','POST',`${base}/members`,{username:'c',role:'viewer'})
  expect((await request('c','POST',`${base}/ask`,{question:'项目进展',scopeIds:['other-scope']})).statusCode).toBe(400)
  let release!:()=>void,entered!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<void>(resolve=>{entered=resolve})
  const retrieve=app.deps.retriever.retrieve.bind(app.deps.retriever)
  vi.spyOn(app.deps.retriever,'retrieve').mockImplementationOnce(async(user,input)=>{
   const result=await retrieve(user,input);entered();await gate;return result
  })
  const response=request('c','POST',`${base}/ask`,{question:'项目进展'})
  await ready
  await request('a','DELETE',`${base}/members/${ids.c}`)
  release()
  expect((await response).statusCode).toBe(404)
 })
})

it('advertises collaboration capabilities and searches active non-member candidates without granting project access',async()=>{
 const caps=await request('a','GET','/api/v1/projects/capabilities')
 expect(caps.json().data).toMatchObject({version:4,projectComments:true,decisionRevisions:true,memberSearch:true,memberRoles:true,idempotentCreate:true,taskIdentity:true})
 const p=await create(),base=`/api/v1/projects/${p.id}`
 const bootstrap=(await request('a','GET','/api/v1/client/bootstrap')).json().data
 expect(bootstrap.projectCollaboration.version).toBe(3)
 expect((await request('a','GET',`${base}/member-candidates?q=ou`)).json().data).toEqual([expect.objectContaining({username:'outsider'})])
 expect((await request('a','GET',`${base}/member-candidates?q=__`)).json().data).toEqual([])
 expect((await request('outsider','GET',`${base}/member-candidates?q=or`)).statusCode).toBe(404)
 await request('a','POST',`${base}/members`,{username:'outsider',role:'viewer'})
 expect((await request('a','GET',`${base}/member-candidates?q=ou`)).json().data).toEqual([])
 expect((await request('outsider','GET',`${base}/member-candidates?q=or`)).statusCode).toBe(403)
 db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(ids.orgadmin)
 expect((await request('a','GET',`${base}/member-candidates?q=org`)).json().data).toEqual([])
})
it('retries a stable local sharing request without duplicating the project and partitions keys by owner',async()=>{
 const clientRequestId=randomUUID(),body={name:'本机项目',goal:'共享目标',clientRequestId}
 const first=(await request('a','POST','/api/v1/projects',body)).json().data
 const second=(await request('a','POST','/api/v1/projects',{...body,name:'later retry'})).json().data
 expect(second.id).toBe(first.id)
 expect(second.name).toBe('本机项目')
 expect((db.prepare('SELECT count(*) AS n FROM projects').get() as {n:number}).n).toBe(1)
 expect((await request('b','POST','/api/v1/projects',body)).json().data.id).not.toBe(first.id)
})
it('changes participant permissions with revision checks, protects the owner, and revokes editing immediately',async()=>{
 const p=await create(),base=`/api/v1/projects/${p.id}`
 await request('a','POST',`${base}/members`,{username:'b',role:'collaborator'})
 let current=(await request('a','GET',base)).json().data
 expect((await request('b','PATCH',`${base}/members/${ids.a}`,{role:'viewer',expectedRevision:current.revision})).statusCode).toBe(403)
 expect((await request('a','PATCH',`${base}/members/${ids.a}`,{role:'viewer',expectedRevision:current.revision})).statusCode).toBe(409)
 expect((await request('a','PATCH',`${base}/members/${ids.b}`,{role:'viewer',expectedRevision:current.revision-1})).statusCode).toBe(409)
 const changed=await request('a','PATCH',`${base}/members/${ids.b}`,{role:'viewer',expectedRevision:current.revision})
 expect(changed.statusCode).toBe(200)
 expect(changed.json().data.members.find((member:{userId:string})=>member.userId===ids.b).role).toBe('viewer')
 expect((await request('b','POST',`${base}/tasks`,{title:'不可写'})).statusCode).toBe(403)
})

it('keeps task identity on retry without overwriting state and isolates identities by project and member',async()=>{
 const p=await create(),base=`/api/v1/projects/${p.id}`,clientRequestId=randomUUID()
 const first=await request('a','POST',`${base}/tasks`,{title:'统一任务',description:'保留原说明',clientRequestId})
 expect(first.statusCode).toBe(200)
 const taskId=first.json().data.id
 await request('a','PATCH',`${base}/tasks/${taskId}`,{expectedRevision:1,status:'review'})
 expect((await request('a','POST',`${base}/tasks`,{title:'不覆盖已有标题',clientRequestId})).json().data.id).toBe(taskId)
 let state=(await request('a','GET',base)).json().data
 expect(state.tasks).toHaveLength(1)
 expect(state.tasks[0]).toMatchObject({title:'统一任务',description:'保留原说明',status:'review',revision:2})
 await request('a','POST',`${base}/members`,{username:'b',role:'collaborator'})
 expect((await request('b','POST',`${base}/tasks`,{title:'另一个人的任务',clientRequestId})).json().data.id).not.toBe(taskId)
 const other=await create()
 expect((await request('a','POST',`/api/v1/projects/${other.id}/tasks`,{title:'另一个项目',clientRequestId})).json().data.id).not.toBe(taskId)
 await request('a','DELETE',`${base}/members/${ids.b}`)
 expect((await request('b','POST',`${base}/tasks`,{title:'已失去权限',clientRequestId})).statusCode).toBe(404)
 state=(await request('a','GET',base)).json().data
 expect(state.tasks).toHaveLength(2)
 expect(db.prepare('SELECT count(*) AS n FROM project_task_requests').get()).toEqual({n:3})
})
