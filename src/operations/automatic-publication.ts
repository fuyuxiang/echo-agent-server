import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { loadManagementContext, canAccessScope } from '../auth/scopes.js'
import { scanDocument, scanSkillPackage, scanNeedsRetry, type ScanReport } from '../security/content-scanner.js'
import { MemoryPayload, DocumentPayload } from './publication-payloads.js'
import { createDocumentFromSubmission, type SubmissionRow } from '../routes/document-submissions.js'
import { inspectSkillPackage, signaturePayload } from '../routes/skills.js'
import { signServerPayload } from '../server-signing.js'

export type PublicationKind = 'promotion' | 'document' | 'skill'
export const publicationTables = { promotion: 'promotions', document: 'document_submissions', skill: 'skill_versions' } as const
export interface PublicationResult { state: string; scanStatus: string; resultId?: string | null; message?: string; busy?: boolean }
class Blocked extends Error { constructor(public code: string, message: string) { super(message) } }
function textValues(value: unknown): string[] { return typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(textValues) : [] }
function errorReport(kind: PublicationKind, code: string, message: string): ScanReport {
  return { version: 1, kind: kind === 'skill' ? 'skill' : 'document', status: 'failed', detectedMime: 'unknown', engines: [], findings: [{ code, severity: 'critical', message }], scannedAt: Date.now() }
}

/** Claim, re-scan, and atomically publish. No trusted human approval or cached clean flag is required. */
export async function processPublication(app: FastifyInstance, kind: PublicationKind, id: string): Promise<PublicationResult> {
  const { db, storage } = app.deps
  const table = publicationTables[kind]
  const row: any = kind === 'skill' ? db.prepare(`SELECT v.*,f.scope_id AS target_scope,f.state AS family_state,f.mandatory,f.allow_personal_override,f.current_version_id FROM skill_versions v JOIN skill_families f ON f.id=v.family_id WHERE v.id=?`).get(id) : db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
  if (!row) return { state: 'missing', scanStatus: 'unknown' }
  if (row.state !== 'pending') return { state: row.state, scanStatus: row.scan_status, resultId: row.result_id ?? row.result_document_id ?? row.family_id }
  const owner = randomUUID(), now = Date.now()
  const claimed = db.prepare(`UPDATE ${table} SET review_lock=?,review_lease_until=?,scan_status='scanning',scan_started_at=? WHERE id=? AND state='pending' AND (review_lock IS NULL OR review_lease_until<?)`).run(owner, now + 300000, now, id, now)
  if (!claimed.changes) return { state: 'pending', scanStatus: 'scanning', busy: true }
  const authorize = () => {
    const user = db.prepare('SELECT role,status FROM users WHERE id=?').get(row.submitter_id) as any
    if (!user || user.status !== 'active') throw new Blocked('AUTHOR_DISABLED', '提交账号已停用，未发布')
    const ctx = loadManagementContext(db, row.submitter_id, user.role)
    if (!canAccessScope(ctx, row.target_scope)) throw new Blocked('ACCESS_REVOKED', '已失去目标范围的访问权限，未发布')
    const scope = db.prepare('SELECT kind,owner_user_id FROM v_effective_scopes WHERE id=?').get(row.target_scope) as any
    if (!scope || (scope.kind === 'personal' && scope.owner_user_id !== row.submitter_id)) throw new Blocked('ACCESS_REVOKED', '目标空间不可用')
    const policy = db.prepare("SELECT allow_skill_submission,allow_personal_cloud FROM enterprise_policy WHERE id='default'").get() as any
    if ((scope.kind === 'personal' && policy?.allow_personal_cloud === 0) || (kind === 'skill' && policy?.allow_skill_submission === 0)) throw new Blocked('POLICY_DISABLED', '当前客户端策略已禁止此类提交')
    if (kind === 'skill' && row.family_state !== 'active') throw new Blocked('SKILL_DISABLED', '技能已被停用，未自动恢复发布')
    return { user, ctx, scope }
  }
  const failed = (report: ScanReport, retry: boolean): PublicationResult => {
    const message = report.findings.filter(f => f.severity === 'critical' || f.severity === 'high').map(f => f.message).join('；') || '安全检查未通过'
    const state = retry ? 'pending' : 'rejected'
    db.prepare(`UPDATE ${table} SET state=?,scan_status='failed',scan_report_json=?,scan_completed_at=?,review_note=?,reviewer_id=NULL,reviewed_at=?,auto_retry_at=? WHERE id=? AND review_lock=? AND state='pending'`).run(state, JSON.stringify(report), Date.now(), message, Date.now(), retry ? Date.now() + 60000 : null, id, owner)
    app.audit(null, 'security_scan_failed', id, { kind, retry, findingCodes: report.findings.map(f => f.code) })
    return { state, scanStatus: 'failed', message }
  }
  try {
    let { ctx, user, scope } = authorize()
    let report: ScanReport, bytes: Buffer | undefined, payload: any
    if (kind === 'promotion') {
      let submitted: unknown
      try { submitted = JSON.parse(row.payload) } catch { throw new Blocked('INVALID_PAYLOAD', '知识内容格式无效，请重新提交') }
      const parsed = (row.payload_type === 'memory' ? MemoryPayload : DocumentPayload).safeParse(submitted)
      if (!parsed.success) throw new Blocked('INVALID_PAYLOAD', '知识内容格式无效，请修改后重新提交')
      payload = parsed.data
      if ((payload.sensitivity ?? 0) > ctx.clearance) throw new Blocked('CLEARANCE_EXCEEDED', '内容密级高于提交人的访问权限')
      if (payload.validFrom && payload.validUntil && payload.validFrom > payload.validUntil) throw new Blocked('INVALID_VALIDITY', '生效时间晚于到期时间')
      if (payload.supersedesId) {
        const prior = db.prepare('SELECT scope_id,author_id FROM org_memories WHERE id=?').get(payload.supersedesId) as any
        if (!prior || prior.scope_id !== row.target_scope || (user.role === 'member' && prior.author_id !== row.submitter_id)) throw new Blocked('REPLACEMENT_FORBIDDEN', '不能自动替换其他成员或其他范围的经验')
      }
      bytes = Buffer.from(row.payload_type === 'memory' ? textValues(payload).join('\n') : payload.text, 'utf8')
      report = await scanDocument(bytes, row.payload_type === 'memory' ? 'txt' : payload.sourceType, app.deps.cfg)
    } else if (kind === 'document') {
      if (row.sensitivity > ctx.clearance) throw new Blocked('CLEARANCE_EXCEEDED', '文档密级高于提交人的访问权限')
      bytes = await storage.get(row.quarantine_storage_key ?? row.storage_key)
      if (createHash('sha256').update(bytes).digest('hex') !== row.content_hash) throw new Blocked('HASH_MISMATCH', '隔离文件校验失败，请重新提交')
      report = await scanDocument(bytes, row.source_type, app.deps.cfg)
    } else {
      bytes = await storage.get(row.quarantine_package_key ?? row.package_key)
      if (createHash('sha256').update(bytes).digest('hex') !== row.content_hash) throw new Blocked('HASH_MISMATCH', '技能包校验失败，请重新提交')
      try { await inspectSkillPackage(bytes, row.version) } catch { throw new Blocked('SKILL_PACKAGE_INVALID', '技能包结构、路径或大小不符合安全要求') }
      report = await scanSkillPackage(bytes, app.deps.cfg)
    }
    if (report.status !== 'passed') return failed(report, scanNeedsRetry(report))
    ;({ctx, user, scope} = authorize()) // Permissions may have changed while the antivirus engine was scanning.
    if (kind === 'document' && row.sensitivity > ctx.clearance || kind === 'promotion' && (payload.sensitivity ?? 0) > ctx.clearance) throw new Blocked('CLEARANCE_EXCEEDED', '扫描期间访问权限发生变化')
    let publishedKey: string | undefined
    if (kind !== 'promotion' || row.payload_type === 'document') publishedKey = await storage.put(bytes!, kind === 'skill' ? 'zip' : kind === 'document' ? (row.storage_key.split('.').at(-1) || row.source_type) : payload.sourceType, kind === 'skill' ? 'published/skills' : 'published/documents')
    let resultId: string
    db.transaction(() => {
      if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND state='pending' AND review_lock=?`).get(id, owner)) throw new Blocked('CLAIM_LOST', '该记录已由其他操作处理')
      if (kind === 'promotion' && row.payload_type === 'memory') {
        const p = payload
        resultId = randomUUID()
        db.prepare(`INSERT INTO org_memories(id,scope_id,kind,content,rationale,evidence,author_id,confidence,status,observed_at,valid_from,valid_until,supersedes_id,source_session_id,source_task_id,workspace_ref,outcome,sensitivity,trust,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,'reported',?,?)`).run(resultId,row.target_scope,p.kind,p.content,p.rationale??null,p.evidence?JSON.stringify(p.evidence):null,row.submitter_id,p.confidence,p.observedAt??now,p.validFrom??null,p.validUntil??null,p.supersedesId??null,p.sourceSessionId??null,p.sourceTaskId??null,p.workspaceRef??null,p.outcome??null,p.sensitivity,now,now)
        if (p.supersedesId) db.prepare("UPDATE org_memories SET status='superseded',updated_at=? WHERE id=? AND scope_id=?").run(now,p.supersedesId,row.target_scope)
      } else if (kind === 'skill') {
        resultId = row.family_id
        const family = db.prepare('SELECT mandatory,allow_personal_override,current_version_id FROM skill_families WHERE id=?').get(row.family_id) as any
        const signature = signServerPayload(app.deps.cfg.masterKey, signaturePayload({familyId:row.family_id,versionId:id,version:row.version,hash:row.content_hash,scopeKind:scope.kind,mandatory:!!family.mandatory,allowPersonalOverride:!!family.allow_personal_override}))
        db.prepare('UPDATE skill_versions SET package_key=?,published_package_key=?,quarantine_package_key=NULL,signature=? WHERE id=?').run(publishedKey,publishedKey,signature,id)
        const current = db.prepare('SELECT created_at FROM skill_versions WHERE id=?').get(family.current_version_id) as any
        if (!current || current.created_at <= row.created_at) db.prepare('UPDATE skill_families SET current_version_id=?,updated_at=? WHERE id=?').run(id,now,row.family_id)
      } else {
        const record: SubmissionRow = kind === 'document' ? {id,submitterId:row.submitter_id,targetScope:row.target_scope,title:row.title,sourceType:row.source_type,storageKey:publishedKey!,contentHash:row.content_hash,byteSize:row.byte_size,sensitivity:row.sensitivity,volatility:row.volatility,tagsJson:row.tags_json,state:'approved'} : {id,submitterId:row.submitter_id,targetScope:row.target_scope,title:payload.title,sourceType:payload.sourceType,storageKey:publishedKey!,contentHash:createHash('sha256').update(bytes!).digest('hex'),byteSize:bytes!.length,sensitivity:0,volatility:payload.volatility??'stable',tagsJson:'[]',state:'approved'}
        const existing = db.prepare("SELECT id FROM documents WHERE scope_id=? AND content_hash=? AND sensitivity<=? AND status NOT IN ('failed','archived') LIMIT 1").get(record.targetScope,record.contentHash,ctx.clearance) as any
        resultId = existing?.id ?? createDocumentFromSubmission(app, record, now)
        if (kind === 'document') db.prepare('UPDATE document_submissions SET storage_key=?,published_storage_key=?,quarantine_storage_key=NULL,result_document_id=? WHERE id=?').run(publishedKey,publishedKey,resultId,id)
      }
      if (kind === 'promotion') db.prepare('UPDATE promotions SET result_id=? WHERE id=?').run(resultId!,id)
      db.prepare(`UPDATE ${table} SET state='approved',scan_status='passed',scan_report_json=?,scan_completed_at=?,review_note='安全检查通过后自动发布',reviewer_id=NULL,reviewed_at=?,auto_retry_at=NULL ${kind === 'skill' ? ',published_at='+Date.now() : ''} WHERE id=? AND review_lock=?`).run(JSON.stringify(report),Date.now(),Date.now(),id,owner)
    })()
    app.audit(null, 'auto_publish', id, { kind, submitterId: row.submitter_id, resultId: resultId! })
    return { state: 'approved', scanStatus: 'passed', resultId: resultId! }
  } catch (error) {
    if (error instanceof Blocked) return failed(errorReport(kind,error.code,error.message),false)
    app.log.warn({kind,id}, '自动安全检查暂未完成，将重试')
    return failed(errorReport(kind,'PUBLICATION_IO_UNAVAILABLE','文件读取或检查服务暂时不可用，系统稍后自动重试'),true)
  } finally {
    db.prepare(`UPDATE ${table} SET review_lock=NULL,review_lease_until=NULL WHERE id=? AND review_lock=?`).run(id,owner)
  }
}

export async function drainPublications(app: FastifyInstance, limit = 20): Promise<number> {
  let processed = 0
  for (const kind of Object.keys(publicationTables) as PublicationKind[]) {
    const table = publicationTables[kind], now = Date.now()
    const rows = app.deps.db.prepare(`SELECT id FROM ${table} WHERE state='pending' AND (auto_retry_at IS NULL OR auto_retry_at<=?) AND (review_lock IS NULL OR review_lease_until<?) AND (scan_status='failed' OR scan_started_at IS NULL OR scan_started_at<?) ORDER BY created_at LIMIT ?`).all(now,now,now-300000,Math.min(limit-processed,Math.ceil(limit/3))) as {id:string}[]
    for (const row of rows) { await processPublication(app,kind,row.id); processed++; if (processed >= limit) return processed }
  }
  return processed
}

export class AutomaticPublicationWorker {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<unknown>
  constructor(private app: FastifyInstance) {}
  start() { const tick=()=>{ if (!this.running) this.running=drainPublications(this.app).catch(()=>this.app.log.warn('自动发布队列稍后重试')).finally(()=>{this.running=undefined}) }; this.timer=setInterval(tick,15000);this.timer.unref();tick() }
  async stop() { if(this.timer)clearInterval(this.timer);await this.running }
}
