import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {readdir,readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import JSZip from 'jszip'
import type {FastifyInstance} from 'fastify'
import {openDb,migrate,type DB} from '../src/db/index.js'
import {buildApp} from '../src/app.js'
import {testConfig} from '../src/config.js'
import {createUser} from '../src/dao/users.js'
import {ensureOrgScope} from '../src/server.js'
import {drainPublications,processPublication} from '../src/operations/automatic-publication.js'
let db:DB,app:FastifyInstance,temp:string,userId:string,org:string,member:string,admin:string
const bearer=(t:string)=>({authorization:`Bearer ${t}`})
beforeEach(async()=>{temp=await mkdtemp(join(tmpdir(),'echo-auto-'));db=openDb({path:':memory:'});org=ensureOrgScope(db);userId=(await createUser(db,{username:'member',password:'test-password'})).id;await createUser(db,{username:'admin',password:'test-password',role:'admin',clearance:2});app=buildApp({db,cfg:testConfig({storageDir:temp}),serveWeb:false});const login=async(username:string)=>(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username,password:'test-password',deviceId:'test-desktop'}})).json().data.accessToken;member=await login('member');admin=await login('admin')})
afterEach(async()=>{await app.close();db.close();await rm(temp,{recursive:true,force:true})})
const promotion=(content='团队文档在项目交付时归档')=>app.inject({method:'POST',url:'/api/v1/promotions',headers:bearer(member),payload:{payloadType:'memory',payload:{kind:'convention',content},source:'manual',targetScope:org}})
async function legacyDocument(id='legacy-doc',content='团队协作手册') {const bytes=Buffer.from(content),key=await app.deps.storage.put(bytes,'txt','quarantine/documents');db.prepare("INSERT INTO document_submissions(id,submitter_id,target_scope,title,source_type,storage_key,quarantine_storage_key,content_hash,state,scan_status,created_at) VALUES(?,?,?,'历史提交','txt',?,?,?,'pending','passed',1)").run(id,userId,org,key,key,createHash('sha256').update(bytes).digest('hex'));return key}
describe('automatic technical safety publication',()=>{
 it('publishes an internal member memory immediately without declaring it human verified',async()=>{const r=await promotion();expect(r.statusCode).toBe(200);expect(r.json().data).toMatchObject({state:'approved',scanStatus:'passed'});expect(db.prepare('SELECT trust,author_id FROM org_memories WHERE id=?').get(r.json().data.resultId)).toEqual({trust:'reported',author_id:userId});expect((db.prepare('SELECT reviewer_id FROM promotions').get() as any).reviewer_id).toBeNull()})
 it('automatically publishes an inline document and attributes its ingestion to the submitter',async()=>{const r=await app.inject({method:'POST',url:'/api/v1/promotions',headers:bearer(member),payload:{payloadType:'document',payload:{title:'交付纪要',text:'交付后保留知识记录'},source:'meeting',targetScope:org}});expect(r.json().data.state).toBe('approved');expect(db.prepare('SELECT requested_by FROM ingest_jobs WHERE doc_id=?').get(r.json().data.resultId)).toEqual({requested_by:userId})})
 it('rejects a virus signature instead of publishing experience text',async()=>{const r=await promotion('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');expect(r.statusCode).toBe(422);expect((db.prepare('SELECT COUNT(*) AS n FROM org_memories').get() as any).n).toBe(0);expect(db.prepare('SELECT state,scan_status FROM promotions').get()).toEqual({state:'rejected',scan_status:'failed'})})
 it('recovers legacy pending documents by rechecking their bytes and is idempotent',async()=>{await legacyDocument();await drainPublications(app);expect(db.prepare('SELECT state,scan_status,reviewer_id FROM document_submissions').get()).toEqual({state:'approved',scan_status:'passed',reviewer_id:null});await drainPublications(app);expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as any).n).toBe(1)})
 it('does not trust a previously passed flag for dangerous legacy content',async()=>{await legacyDocument('bad','X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');await drainPublications(app);expect((db.prepare("SELECT state FROM document_submissions WHERE id='bad'").get() as any).state).toBe('rejected');expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as any).n).toBe(0)})
 it('keeps content isolated and retries automatically when the required antivirus engine recovers',async()=>{await legacyDocument();app.deps.cfg.antivirusRequired=true;const first=await processPublication(app,'document','legacy-doc');expect(first).toMatchObject({state:'pending',scanStatus:'failed'});expect((db.prepare('SELECT auto_retry_at FROM document_submissions').get() as any).auto_retry_at).toBeGreaterThan(Date.now());app.deps.cfg.antivirusRequired=false;db.prepare('UPDATE document_submissions SET auto_retry_at=0').run();await drainPublications(app);expect((db.prepare('SELECT state FROM document_submissions').get() as any).state).toBe('approved')})
 it('does not publish pending content from a disabled author',async()=>{await legacyDocument();db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(userId);await drainPublications(app);expect((db.prepare('SELECT state FROM document_submissions').get() as any).state).toBe('rejected')})
 it('allows an administrator to rescan but never bypasses a detected threat',async()=>{await legacyDocument('bad','<script>bad()</script>');await processPublication(app,'document','bad');const r=await app.inject({method:'POST',url:'/api/v1/admin/security-checks/document/bad/retry',headers:bearer(admin)});expect(r.statusCode).toBe(200);expect(r.json().data.state).toBe('rejected');expect((await app.inject({url:'/api/v1/admin/security-checks',headers:bearer(member)})).statusCode).toBe(403);const list=await app.inject({url:'/api/v1/admin/security-checks?status=failed',headers:bearer(admin)});expect(list.json().data.items[0].scanReport.findings.some((f:any)=>f.code==='DOCUMENT_ACTIVE_SCRIPT')).toBe(true)})
 it('serializes automatic processing so concurrent checks cannot publish twice',async()=>{await legacyDocument();const results=await Promise.all([processPublication(app,'document','legacy-doc'),processPublication(app,'document','legacy-doc')]);expect(results.filter(r=>r.state==='approved')).toHaveLength(1);expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as any).n).toBe(1)})
 it('automatically publishes a legacy clean skill, signing the current distribution policy',async()=>{const zip=new JSZip();zip.file('SKILL.md','---\nname: safe-skill\ndescription: 安全复用组织流程\nversion: 1.0.0\n---\n使用组织模板');const bytes=await zip.generateAsync({type:'nodebuffer'}),key=await app.deps.storage.put(bytes,'zip','quarantine/skills');db.prepare("INSERT INTO skill_families(id,scope_id,slug,name,description,owner_id,mandatory,allow_personal_override,created_at,updated_at) VALUES('sf',?,'safe-skill','Safe','safe',?,1,0,1,1)").run(org,userId);db.prepare("INSERT INTO skill_versions(id,family_id,version,package_key,content_hash,package_bytes,manifest_json,signature,state,submitter_id,created_at,scan_status) VALUES('sv','sf','1.0.0',?,?,?,'{}','old','pending',?,1,'passed')").run(key,createHash('sha256').update(bytes).digest('hex'),bytes.length,userId);await drainPublications(app);expect(db.prepare("SELECT state,scan_status FROM skill_versions WHERE id='sv'").get()).toEqual({state:'approved',scan_status:'passed'});expect((db.prepare("SELECT current_version_id FROM skill_families WHERE id='sf'").get() as any).current_version_id).toBe('sv')})
 it('queues a newly uploaded shared skill during an antivirus outage and automatically publishes after recovery',async()=>{
  const zip=new JSZip();zip.file('SKILL.md','---\nname: outage-skill\ndescription: 组织模板\nversion: 1.0.0\n---\n使用组织模板')
  const bytes=await zip.generateAsync({type:'nodebuffer'}),boundary='----AutoSafetyTestBoundary'
  const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="scopeId"\r\n\r\n${org}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])
  app.deps.cfg.antivirusRequired=true
  const r=await app.inject({method:'POST',url:'/api/v1/skill-submissions',headers:{...bearer(member),'content-type':`multipart/form-data; boundary=${boundary}`},payload})
  expect(r.statusCode).toBe(422)
  expect(db.prepare('SELECT state,scan_status FROM skill_versions').get()).toEqual({state:'pending',scan_status:'failed'})
  expect((db.prepare('SELECT current_version_id FROM skill_families').get() as any).current_version_id).toBeNull()
  app.deps.cfg.antivirusRequired=false;db.prepare('UPDATE skill_versions SET auto_retry_at=0').run();await drainPublications(app)
  expect(db.prepare('SELECT state,scan_status FROM skill_versions').get()).toEqual({state:'approved',scan_status:'passed'})
 })

 it('migrates an old scanner outage into automatic retry while preserving real threat blocks',async()=>{
  const legacy=openDb({path:':memory:',skipMigrate:true})
  try {
    const dir=new URL('../src/db/migrations/',import.meta.url)
    for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort().slice(0,11))legacy.exec(await readFile(new URL(name,dir),'utf8'))
    legacy.pragma('user_version = 11');const scope=ensureOrgScope(legacy),user=await createUser(legacy,{username:'legacy',password:'test-password'})
    for(const [id,codes] of [['outage',['ANTIVIRUS_UNAVAILABLE']],['virus',['ANTIVIRUS_UNAVAILABLE','ANTIVIRUS_DETECTED']]] as const){
      legacy.prepare("INSERT INTO document_submissions(id,submitter_id,target_scope,title,source_type,storage_key,content_hash,state,scan_status,scan_report_json,created_at) VALUES(?,?,?,'旧记录','txt','legacy.txt','hash','rejected','failed',?,1)").run(id,user.id,scope,JSON.stringify({findings:codes.map(code=>({code,severity:'critical'}))}))
    }
    migrate(legacy)
    expect(legacy.prepare("SELECT state,auto_retry_at FROM document_submissions WHERE id='outage'").get()).toEqual({state:'pending',auto_retry_at:0})
    expect((legacy.prepare("SELECT state FROM document_submissions WHERE id='virus'").get() as any).state).toBe('rejected')
  }finally{legacy.close()}
 })

})
