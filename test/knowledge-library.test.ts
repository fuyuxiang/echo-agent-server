import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, type DB } from '../src/db/index.js'
import { testConfig } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { createUser } from '../src/dao/users.js'
import { ensureOrgScope } from '../src/server.js'
import { createDocumentFamily, activateDocumentVersion } from '../src/dao/documents.js'

let db:DB, app:FastifyInstance, directory:string, token:string, userId:string, otherId:string, scope:string
beforeEach(async()=>{
  directory=mkdtempSync(join(tmpdir(),'echo-library-'))
  db=openDb({path:':memory:'})
  scope=ensureOrgScope(db)
  const user=await createUser(db,{username:'alice',password:'library-password',clearance:1})
  const other=await createUser(db,{username:'bob',password:'library-password'})
  userId=user.id;otherId=other.id
  app=buildApp({db,cfg:testConfig({storageDir:directory}),serveWeb:false})
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'alice',password:'library-password',deviceId:'library-test'}})
  token=login.json().data.accessToken
})
afterEach(async()=>{await app.close();db.close();rmSync(directory,{recursive:true,force:true})})
const get=(resource:string,params:Record<string,string|number>={})=>app.inject({method:'GET',url:'/api/v1/knowledge/library?'+new URLSearchParams({resource,...Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)]))}),headers:{authorization:`Bearer ${token}`}})
function memory(id:string,content=id,target=scope,sensitivity=0){db.prepare("INSERT INTO org_memories(id,scope_id,kind,content,author_id,sensitivity,created_at,updated_at) VALUES (?,?,'howto',?,?,?,?,1)").run(id,target,content,userId,sensitivity,1)}
function promotion(id:string,owner=userId){db.prepare("INSERT INTO promotions(id,submitter_id,target_scope,payload_type,payload,source,state,created_at) VALUES (?,?,?,'memory',?,'manual','pending',1)").run(id,owner,scope,JSON.stringify({kind:'howto',content:id}))}
function skill(id:string,mandatory=false,owner=userId){
 db.prepare("INSERT INTO skill_families(id,scope_id,slug,name,description,owner_id,mandatory,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)").run(id,scope,id,id,'发布校验',owner,mandatory?1:0)
 db.prepare("INSERT INTO skill_versions(id,family_id,version,package_key,content_hash,package_bytes,manifest_json,signature,state,submitter_id,created_at) VALUES (?,?,'1.0.0','unused','hash',1,'{}','unused','approved',?,1)").run('v-'+id,id,owner)
 db.prepare('UPDATE skill_families SET current_version_id=? WHERE id=?').run('v-'+id,id)
}
function document(id:string,status='ready'){
 const family=createDocumentFamily(db,{scopeId:scope,title:id,ownerId:userId,now:1})
 db.prepare("INSERT INTO documents(id,family_id,scope_id,title,source_type,content_hash,status,owner_id,created_at,updated_at) VALUES (?,?,?,?,'md',?,?,?,1,1)").run(id,family,scope,id,id,status,userId)
 if(status==='ready')activateDocumentVersion(db,id,1)
}

describe('组织资源工作区分页与权限',()=>{
 it('经验超过旧接口200条上限后仍可分页和全量搜索，排序稳定',async()=>{
   for(let i=0;i<245;i++)memory(`m-${String(i).padStart(3,'0')}`,i===244?'末页唯一经验':'发布校验')
   const first=(await get('memories')).json().data
   const next=(await get('memories',{page:2})).json().data
   expect(first.total).toBe(245);expect(first.items).toHaveLength(20)
   expect(new Set([...first.items,...next.items].map((item:{id:string})=>item.id)).size).toBe(40)
   expect((await get('memories',{page:13})).json().data.items).toHaveLength(5)
   expect((await get('memories',{q:'末页唯一'})).json().data).toMatchObject({total:1,items:[{id:'m-244'}]})
   const old=await app.inject({url:'/api/v1/memories',headers:{authorization:`Bearer ${token}`}})
   expect(old.json().data).toHaveLength(200)
 })
 it('搜索将SQL通配符视为普通文字，并支持范围与类型组合',async()=>{
   memory('literal','包含 50%_done 的经验');memory('ordinary','普通经验')
   expect((await get('memories',{q:'%_'})).json().data.total).toBe(1)
   expect((await get('memories',{scopeId:scope,filter:'fact'})).json().data.total).toBe(0)
   expect((await get('memories',{scopeId:scope,filter:'howto'})).json().data.total).toBe(2)
 })
 it('列表和概览统计同时遵守授权范围和密级',async()=>{
   db.prepare("INSERT INTO groups(id,name,created_at) VALUES ('private-group','保密团队',1)").run()
   db.prepare("INSERT INTO scopes(id,kind,group_id,name) VALUES ('private-scope','team','private-group','保密团队')").run()
   memory('visible');memory('sensitive','不可见密级',scope,2);memory('private','不可见团队','private-scope')
   expect((await get('memories')).json().data.total).toBe(1)
   expect((await get('memories',{scopeId:'private-scope'})).json().data.total).toBe(0)
   expect((await get('summary')).json().data.memories).toBe(1)
 })
 it('经验、文档、Skill提交历史均可越过100条且不暴露他人提交',async()=>{
   for(let i=0;i<115;i++){
     promotion(`promotion-${i}`);skill(`skill-${i}`)
     db.prepare("INSERT INTO document_submissions(id,submitter_id,target_scope,title,source_type,storage_key,content_hash,state,created_at) VALUES (?,?,?,?,'md','unused','hash','pending',1)").run(`doc-sub-${i}`,userId,scope,`报告${i}`)
   }
   promotion('others-promotion',otherId);skill('others-skill',false,otherId)
   for(const resource of ['memory-submissions','document-submissions','skill-submissions']){
     const response=await get(resource,{page:6});expect(response.statusCode).toBe(200)
     expect(response.json().data.total).toBe(115);expect(response.json().data.items).toHaveLength(15)
   }
   expect((await get('memory-submissions',{q:'promotion-114'})).json().data.total).toBe(1)
 })
 it('技能安装筛选包含组织必装，并返回正确布尔状态',async()=>{
   skill('mandatory',true);skill('optional');skill('installed')
   db.prepare('INSERT INTO skill_user_preferences(user_id,skill_id,enabled,updated_at) VALUES (?,?,1,1)').run(userId,'installed')
   const installed=(await get('skills',{filter:'installed'})).json().data
   expect(installed.total).toBe(2);expect(installed.items.every((item:{enabled:boolean})=>item.enabled===true)).toBe(true)
   expect((await get('skills',{filter:'available'})).json().data.total).toBe(1)
   expect((await get('summary')).json().data).toMatchObject({skills:3,skillInstalled:2,skillMandatory:1})
 })
 it('文档统计覆盖全部分页，同时区分可检索、处理和失败状态',async()=>{
   for(let i=0;i<123;i++)document(`ready-${i}`)
   document('processing','embedding');document('failed','failed');document('archived','archived')
   expect((await get('documents')).json().data).toMatchObject({total:125,items:expect.any(Array)})
   expect((await get('documents',{filter:'processing'})).json().data).toMatchObject({total:1,items:[{id:'processing'}]})
   expect((await get('summary')).json().data).toMatchObject({documents:125,documentReady:123,documentProcessing:1})
 })
 it('拒绝未认证请求、非法资源、超大分页和错误筛选',async()=>{
   expect((await app.inject({url:'/api/v1/knowledge/library?resource=summary'})).statusCode).toBe(401)
   for(const [resource,params] of [['invalid',{}],['skills',{size:101}],['memories',{page:0}],['documents',{filter:'mandatory'}],['skills',{q:'x'.repeat(2001)}]] as const)expect((await get(resource,params)).statusCode).toBe(400)
 })
})
