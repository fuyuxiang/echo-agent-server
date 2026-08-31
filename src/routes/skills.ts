import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import JSZip from 'jszip'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { type AuthedRequest, requireCurator } from '../auth/jwt.js'
import { canAccessScope, loadAccessContext } from '../auth/scopes.js'
import { fail, ok } from '../reply.js'
import { signServerPayload } from '../server-signing.js'
import { scanSkillPackage, type ScanReport } from '../security/content-scanner.js'

const MAX_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024
const MAX_SKILL_UNCOMPRESSED_BYTES = 20 * 1024 * 1024
const MAX_SKILL_FILES = 200
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/
const FORBIDDEN_EXT = /\.(?:exe|dll|dylib|so|msi|app|com|scr)$/i
const PublishSkillSchema = z.object({
  targetScopeId: z.string().min(1),
  version: z.string().regex(SEMVER).optional(),
  changelog: z.string().max(4000).optional()
})

interface PackageManifest {
  name: string
  description: string
  version: string
  files: string[]
}

interface VersionRow {
  versionId: string
  familyId: string
  scopeId: string
  scopeKind: string
  slug: string
  name: string
  description: string
  version: string
  packageKey: string
  contentHash: string
  packageBytes: number
  signature: string
  state: string
  submitterId: string
  ownerId: string | null
  mandatory: number
  allowPersonalOverride: number
  scanStatus?: string
  scanReportJson?: string | null
  changelog?: string | null
  quarantinePackageKey?: string | null
  publishedPackageKey?: string | null
}

function parseFrontmatter(frontmatter: string): Record<string, unknown> {
  const document = parseDocument(frontmatter, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true
  })
  if (document.errors.length > 0) {
    throw new Error(`SKILL.md YAML frontmatter 无效: ${document.errors[0].message}`)
  }
  const value = document.toJS({ maxAliasCount: 20 }) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SKILL.md YAML frontmatter 必须是键值对象')
  }
  return value as Record<string, unknown>
}

function stringField(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key]
  return typeof value === 'string' ? value.trim() : undefined
}

function safeArchivePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false
  if (path.includes('\\')) return false
  const parts = path.split('/')
  return parts.length <= 12 && !parts.some((part) => part === '..' || part === '')
}

function isSymbolicLink(entry: JSZip.JSZipObject): boolean {
  const raw = entry.unixPermissions
  const mode = typeof raw === 'string' ? Number.parseInt(raw, 8) : raw
  return typeof mode === 'number' && (mode & 0o170000) === 0o120000
}

async function inspectSkillPackage(buf: Buffer, requestedVersion?: string): Promise<PackageManifest> {
  if (buf.length > MAX_SKILL_PACKAGE_BYTES) throw new Error('技能包超过 10MB 上限')
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf, { checkCRC32: true, createFolders: false })
  } catch {
    throw new Error('技能包不是有效 ZIP')
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (entries.length === 0 || entries.length > MAX_SKILL_FILES) {
    throw new Error(`技能包文件数必须在 1-${MAX_SKILL_FILES} 之间`)
  }

  let declaredBytes = 0
  for (const entry of entries) {
    const original = (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name
    if (!safeArchivePath(original) || !safeArchivePath(entry.name)) throw new Error(`包内路径不安全: ${original}`)
    if (isSymbolicLink(entry)) throw new Error(`包内不允许符号链接: ${entry.name}`)
    if (FORBIDDEN_EXT.test(entry.name)) throw new Error(`包内含禁止的可执行文件: ${entry.name}`)
    const size = Number(
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    )
    declaredBytes += size
    if (declaredBytes > MAX_SKILL_UNCOMPRESSED_BYTES) throw new Error('技能包解压后超过 20MB 上限')
  }

  const skillEntries = entries.filter((entry) => entry.name === 'SKILL.md' || entry.name.endsWith('/SKILL.md'))
  const skillEntry = skillEntries.find((entry) => entry.name === 'SKILL.md')
  if (!skillEntry) throw new Error('技能包根目录必须包含 SKILL.md')
  if (skillEntries.length !== 1) throw new Error('技能包只能包含一个 SKILL.md 入口')
  const skillMd = await skillEntry.async('string')
  if (Buffer.byteLength(skillMd, 'utf8') > 1024 * 1024) throw new Error('SKILL.md 不得超过 1MB')
  const frontmatterText = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillMd)?.[1]
  if (!frontmatterText) throw new Error('SKILL.md 缺少 YAML frontmatter')
  const frontmatter = parseFrontmatter(frontmatterText)
  const name = stringField(frontmatter, 'name')?.toLowerCase()
  const description = stringField(frontmatter, 'description')
  const version = requestedVersion ?? stringField(frontmatter, 'version') ?? '1.0.0'
  if (!name || !SKILL_NAME.test(name)) {
    throw new Error('Skill name 必须是 2-64 位小写字母、数字、_ 或 -')
  }
  if (!description || description.length > 1000) throw new Error('Skill description 必须为 1-1000 字符')
  if (!SEMVER.test(version)) throw new Error('Skill version 必须为 SemVer，例如 1.0.0')

  // 真正解压计数再做一次上限校验，避免依赖 ZIP 声明尺寸。
  let actualBytes = 0
  for (const entry of entries) {
    actualBytes += (await entry.async('uint8array')).byteLength
    if (actualBytes > MAX_SKILL_UNCOMPRESSED_BYTES) throw new Error('技能包解压后超过 20MB 上限')
  }
  return { name, description, version, files: entries.map((entry) => entry.name).sort() }
}

function signaturePayload(input: {
  familyId: string
  versionId: string
  version: string
  hash: string
  scopeKind: string
  mandatory: boolean
  allowPersonalOverride: boolean
}): string {
  // 签名不只绑定包 hash，还绑定治理属性，避免本地 sidecar
  // 把强制/不可覆盖改宽后仍被 Runtime 接受。
  return JSON.stringify({
    schema: 'echo-managed-skill/v2',
    skillId: input.familyId,
    versionId: input.versionId,
    version: input.version,
    hash: input.hash,
    scopeKind: input.scopeKind,
    mandatory: input.mandatory,
    allowPersonalOverride: input.allowPersonalOverride
  })
}

function scanFailure(report: ScanReport): string {
  return report.findings
    .filter((item) => item.severity === 'high' || item.severity === 'critical')
    .map((item) => item.message)
    .join('；') || 'Skill 技术扫描未通过'
}

function canManageVersion(app: FastifyInstance, userId: string, role: string, row: VersionRow): boolean {
  if (role === 'admin') return true
  const ctx = loadAccessContext(app.deps.db, userId)
  return role === 'curator' && canAccessScope(ctx, row.scopeId)
}

function versionById(app: FastifyInstance, versionId: string): VersionRow | undefined {
  return app.deps.db.prepare(
    `SELECT sv.id AS versionId, sf.id AS familyId, sf.scope_id AS scopeId,
            s.kind AS scopeKind, sf.slug, sf.name, sf.description,
            sv.version, sv.package_key AS packageKey, sv.content_hash AS contentHash,
            sv.package_bytes AS packageBytes, sv.signature, sv.state,
            sv.submitter_id AS submitterId, sf.owner_id AS ownerId,
            sf.mandatory, sf.allow_personal_override AS allowPersonalOverride,
            sv.scan_status AS scanStatus, sv.scan_report_json AS scanReportJson,
            sv.changelog, sv.quarantine_package_key AS quarantinePackageKey,
            sv.published_package_key AS publishedPackageKey
       FROM skill_versions sv
       JOIN skill_families sf ON sf.id = sv.family_id
       JOIN v_effective_scopes s ON s.id = sf.scope_id
      WHERE sv.id = ?`
  ).get(versionId) as VersionRow | undefined
}

export function registerSkillRoutes(app: FastifyInstance): void {
  const { db, cfg, storage } = app.deps

  app.post('/api/v1/skill-submissions', { preHandler: app.authenticate }, async (req, reply) => {
    const data = await req.file({ limits: { fileSize: MAX_SKILL_PACKAGE_BYTES } })
    if (!data) return reply.code(400).send(fail(4001, '缺少 Skill ZIP'))
    const fields = data.fields as Record<string, { value?: string } | undefined>
    const scopeId = fields.scopeId?.value
    if (!scopeId) return reply.code(400).send(fail(4001, '缺少 scopeId'))
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    if (!canAccessScope(ctx, scopeId)) return reply.code(403).send(fail(4033, '无权向该范围提交 Skill'))
    const scope = db.prepare(
      'SELECT kind, owner_user_id AS ownerUserId FROM v_effective_scopes WHERE id = ?'
    ).get(scopeId) as { kind: 'personal' | 'team' | 'org'; ownerUserId: string | null } | undefined
    if (!scope) return reply.code(400).send(fail(4001, '目标 scope 不存在'))
    if (scope.kind === 'personal' && scope.ownerUserId !== claims.sub) {
      return reply.code(403).send(fail(4033, '不能向他人个人空间提交 Skill'))
    }
    const policy = db.prepare(
      `SELECT allow_skill_submission AS allowSkillSubmission,
              allow_personal_cloud AS allowPersonalCloud
         FROM enterprise_policy WHERE id='default'`
    ).get() as { allowSkillSubmission: number; allowPersonalCloud: number } | undefined
    if (policy?.allowSkillSubmission === 0) {
      return reply.code(403).send(fail(4036, '企业策略已禁用托管 Skill 提交'))
    }
    if (scope.kind === 'personal' && policy?.allowPersonalCloud === 0) {
      return reply.code(403).send(fail(4036, '企业策略已禁用个人云空间'))
    }
    if (!/\.zip$/i.test(data.filename ?? '')) return reply.code(415).send(fail(4151, 'Skill 必须上传 ZIP 包'))
    const buf = await data.toBuffer()
    if (data.file.truncated) return reply.code(413).send(fail(4131, 'Skill 包超过 10MB 上限'))

    let manifest: PackageManifest
    try {
      manifest = await inspectSkillPackage(buf, fields.version?.value)
    } catch (error) {
      return reply.code(400).send(fail(4004, error instanceof Error ? error.message : String(error)))
    }

    const now = Date.now()
    let family = db.prepare(
      'SELECT id, owner_id AS ownerId FROM skill_families WHERE scope_id = ? AND slug = ?'
    ).get(scopeId, manifest.name) as { id: string; ownerId: string | null } | undefined
    if (family && family.ownerId !== claims.sub && claims.role === 'member') {
      return reply.code(409).send(fail(4094, '同名 Skill 已由其他人管理'))
    }
    const familyId = family?.id ?? randomUUID()
    const versionId = randomUUID()
    const hash = createHash('sha256').update(buf).digest('hex')
    const prior = family
      ? db.prepare('SELECT id, state FROM skill_versions WHERE family_id = ? AND version = ?').get(
          familyId,
          manifest.version
        ) as { id: string; state: string } | undefined
      : undefined
    if (prior) return reply.code(409).send(fail(4095, `版本 ${manifest.version} 已存在(${prior.state})`))

    const quarantineKey = await storage.put(buf, 'zip', 'quarantine/skills')
    const scanStartedAt = Date.now()
    const scanReport = await scanSkillPackage(buf, cfg)
    const scanPassed = scanReport.status === 'passed'
    const autoApprove = scanPassed && (scope.kind === 'personal' || claims.role !== 'member')
    const packageKey = autoApprove
      ? await storage.move(quarantineKey, 'published/skills')
      : quarantineKey
    const signature = signServerPayload(
      cfg.masterKey,
      signaturePayload({
        familyId,
        versionId,
        version: manifest.version,
        hash,
        scopeKind: scope.kind,
        mandatory: false,
        allowPersonalOverride: true
      })
    )
    const finalState = !scanPassed ? 'rejected' : autoApprove ? 'approved' : 'pending'
    db.transaction(() => {
      if (!family) {
        db.prepare(
          `INSERT INTO skill_families
             (id, scope_id, slug, name, description, owner_id, state,
              mandatory, allow_personal_override, created_at, updated_at)
           VALUES (?,?,?,?,?,?,'active',0,1,?,?)`
        ).run(familyId, scopeId, manifest.name, manifest.name, manifest.description, claims.sub, now, now)
        family = { id: familyId, ownerId: claims.sub }
      } else {
        db.prepare(
          `UPDATE skill_families SET name=?, description=?, state='active', updated_at=? WHERE id=?`
        ).run(manifest.name, manifest.description, now, familyId)
      }
      db.prepare(
        `INSERT INTO skill_versions
           (id, family_id, version, package_key, content_hash, package_bytes,
            manifest_json, signature, state, submitter_id, reviewer_id,
            created_at, reviewed_at, published_at, quarantine_package_key,
            published_package_key, scan_status, scan_report_json, changelog,
            scan_started_at, scan_completed_at, review_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        versionId,
        familyId,
        manifest.version,
        packageKey,
        hash,
        buf.length,
        JSON.stringify(manifest),
        signature,
        finalState,
        claims.sub,
        autoApprove ? claims.sub : null,
        now,
        autoApprove || !scanPassed ? now : null,
        autoApprove ? now : null,
        autoApprove ? null : quarantineKey,
        autoApprove ? packageKey : null,
        scanPassed ? 'passed' : 'failed',
        JSON.stringify(scanReport),
        fields.changelog?.value?.trim().slice(0, 4000) || null,
        scanStartedAt,
        Date.now(),
        scanPassed ? null : scanFailure(scanReport)
      )
      if (autoApprove) {
        db.prepare(
          `UPDATE skill_families SET current_version_id=?, state='active', updated_at=? WHERE id=?`
        ).run(versionId, now, familyId)
      }
    })()
    app.audit(req, !scanPassed ? 'skill_scan_failed' : autoApprove ? 'skill_publish' : 'skill_submit', versionId, {
      familyId,
      scopeId,
      version: manifest.version,
      hash,
      findingCodes: scanReport.findings.map((item) => item.code)
    })
    if (!scanPassed) {
      return reply.code(422).send(fail(4222, `Skill 技术扫描未通过: ${scanFailure(scanReport)}`))
    }
    return reply.send(ok({
      submissionId: versionId,
      skillId: familyId,
      version: manifest.version,
      state: autoApprove ? 'approved' : 'pending',
      scanStatus: 'passed',
      scanReport,
      hash
    }))
  })

  app.get('/api/v1/skill-submissions/mine', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const rows = db.prepare(
      `SELECT sv.id AS submissionId, sf.id AS skillId, sf.name, sv.version, sv.state,
              sv.scan_status AS scanStatus, sv.scan_report_json AS scanReportJson,
              sv.changelog, sv.review_note AS reviewNote, sv.created_at AS createdAt,
              sv.reviewed_at AS reviewedAt, s.id AS scopeId, s.name AS scopeName,
              s.kind AS scopeKind, r.display_name AS reviewerName
         FROM skill_versions sv
         JOIN skill_families sf ON sf.id = sv.family_id
         JOIN v_effective_scopes s ON s.id = sf.scope_id
         LEFT JOIN users r ON r.id = sv.reviewer_id
        WHERE sv.submitter_id = ? ORDER BY sv.created_at DESC LIMIT 100`
    ).all(claims.sub)
    return reply.send(ok((rows as Record<string, unknown>[]).map((row) => ({
      ...row,
      scanReport: typeof row.scanReportJson === 'string' ? JSON.parse(row.scanReportJson) : null,
      scanReportJson: undefined
    }))))
  })

  app.get('/api/v1/admin/skill-submissions', {
    preHandler: [app.authenticate, requireCurator]
  }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const ctx = loadAccessContext(db, claims.sub)
    const state = String((req.query as { state?: string }).state ?? 'pending')
    if (!['pending', 'approved', 'rejected', 'revoked'].includes(state)) {
      return reply.code(400).send(fail(4001, '非法的 state'))
    }
    const where = ['sv.state = ?']
    const params: unknown[] = [state]
    if (claims.role !== 'admin') {
      where.push(`sf.scope_id IN (${ctx.scopeIds.map(() => '?').join(',') || "''"})`)
      params.push(...ctx.scopeIds)
    }
    const rows = db.prepare(
      `SELECT sv.id AS submissionId, sf.id AS skillId, sf.name, sf.description,
              sv.version, sv.package_bytes AS packageBytes, sv.content_hash AS hash,
              sv.state, sv.scan_status AS scanStatus,
              sv.scan_report_json AS scanReportJson, sv.changelog,
              sv.created_at AS createdAt, s.id AS scopeId,
              s.name AS scopeName, s.kind AS scopeKind,
              u.id AS submitterId, u.display_name AS submitterName
         FROM skill_versions sv
         JOIN skill_families sf ON sf.id = sv.family_id
         JOIN v_effective_scopes s ON s.id = sf.scope_id
         JOIN users u ON u.id = sv.submitter_id
        WHERE ${where.join(' AND ')} ORDER BY sv.created_at LIMIT 200`
    ).all(...params) as Record<string, unknown>[]
    return reply.send(ok(rows.map((row) => ({
      ...row,
      scanReport: typeof row.scanReportJson === 'string' ? JSON.parse(row.scanReportJson) : null,
      scanReportJson: undefined
    }))))
  })

  app.post('/api/v1/admin/skill-submissions/:id/approve', {
    preHandler: [app.authenticate, requireCurator]
  }, async (req, reply) => {
    const parsed = z.object({
      note: z.string().max(2000).optional(),
      mandatory: z.boolean().optional(),
      allowPersonalOverride: z.boolean().optional()
    }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
    const claims = (req as AuthedRequest).claims
    if (parsed.data.mandatory && claims.role !== 'admin') {
      return reply.code(403).send(fail(4035, '只有管理员可发布强制 Skill'))
    }
    const versionId = (req.params as { id: string }).id
    const row = versionById(app, versionId)
    if (!row) return reply.code(404).send(fail(4041, '提交不存在'))
    if (row.state !== 'pending') return reply.code(409).send(fail(4093, `该提交已处理(${row.state})`))
    if (row.scanStatus !== 'passed') {
      return reply.code(409).send(fail(4096, `技术扫描未通过(${row.scanStatus ?? 'unknown'})`))
    }
    if (!canManageVersion(app, claims.sub, claims.role, row)) {
      return reply.code(403).send(fail(4034, '无权审核该范围的 Skill'))
    }
    const now = Date.now()
    const mandatory = parsed.data.mandatory ?? !!row.mandatory
    const allowPersonalOverride = parsed.data.allowPersonalOverride ?? !!row.allowPersonalOverride
    const publishedKey = row.publishedPackageKey ?? await storage.move(
      row.quarantinePackageKey ?? row.packageKey,
      'published/skills'
    )
    const signature = signServerPayload(cfg.masterKey, signaturePayload({
      familyId: row.familyId,
      versionId,
      version: row.version,
      hash: row.contentHash,
      scopeKind: row.scopeKind,
      mandatory,
      allowPersonalOverride
    }))
    db.transaction(() => {
      db.prepare(
        `UPDATE skill_versions SET state='approved', reviewer_id=?, review_note=?,
                reviewed_at=?, published_at=?, package_key=?, published_package_key=?,
                quarantine_package_key=NULL, signature=?
          WHERE id=? AND state='pending'`
      ).run(claims.sub, parsed.data.note ?? null, now, now, publishedKey, publishedKey, signature, versionId)
      db.prepare(
        `UPDATE skill_families SET current_version_id=?, state='active',
                mandatory=COALESCE(?, mandatory),
                allow_personal_override=COALESCE(?, allow_personal_override), updated_at=?
          WHERE id=?`
      ).run(
        versionId,
        Number(mandatory),
        Number(allowPersonalOverride),
        now,
        row.familyId
      )
    })()
    app.audit(req, 'skill_approve', versionId, { familyId: row.familyId })
    return reply.send(ok({ state: 'approved', skillId: row.familyId, versionId }))
  })

  app.get('/api/v1/admin/skill-submissions/:id/package', {
    preHandler: [app.authenticate, requireCurator]
  }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const versionId = (req.params as { id: string }).id
    const row = versionById(app, versionId)
    if (!row || !canManageVersion(app, claims.sub, claims.role, row)) {
      return reply.code(404).send(fail(4041, 'Skill 提交不存在或无权访问'))
    }
    const buf = await storage.get(row.packageKey)
    app.audit(req, 'skill_review_download', versionId, { familyId: row.familyId })
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${row.slug}-${row.version}.zip"`)
      .header('x-echo-content-sha256', row.contentHash)
      .header('x-content-type-options', 'nosniff')
      .send(buf)
  })

  app.post('/api/v1/admin/skill-submissions/:id/reject', {
    preHandler: [app.authenticate, requireCurator]
  }, async (req, reply) => {
    const parsed = z.object({ note: z.string().min(1).max(2000) }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '请说明驳回原因'))
    const claims = (req as AuthedRequest).claims
    const versionId = (req.params as { id: string }).id
    const row = versionById(app, versionId)
    if (!row) return reply.code(404).send(fail(4041, '提交不存在'))
    if (row.state !== 'pending') return reply.code(409).send(fail(4093, `该提交已处理(${row.state})`))
    if (!canManageVersion(app, claims.sub, claims.role, row)) {
      return reply.code(403).send(fail(4034, '无权审核该范围的 Skill'))
    }
    db.prepare(
      `UPDATE skill_versions SET state='rejected', reviewer_id=?, review_note=?, reviewed_at=?
        WHERE id=? AND state='pending'`
    ).run(claims.sub, parsed.data.note, Date.now(), versionId)
    app.audit(req, 'skill_reject', versionId)
    return reply.send(ok({ state: 'rejected' }))
  })

  app.get('/api/v1/skills', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const rows = db.prepare(
      `SELECT sf.id AS skillId, sf.slug, sf.name, sf.description, sv.id AS versionId,
              sv.version, sv.content_hash AS hash, sv.package_bytes AS packageBytes,
              sv.signature, sf.mandatory,
              sf.allow_personal_override AS allowPersonalOverride,
              sf.updated_at AS updatedAt, s.id AS scopeId, s.name AS scopeName,
              s.kind AS scopeKind,
              COALESCE(pref.enabled, 0) AS enabled
         FROM skill_families sf
         JOIN skill_versions sv ON sv.id = sf.current_version_id AND sv.state='approved'
         JOIN v_effective_scopes s ON s.id = sf.scope_id
         JOIN v_user_scopes us ON us.scope_id = sf.scope_id AND us.user_id = ?
         LEFT JOIN skill_user_preferences pref
           ON pref.skill_id=sf.id AND pref.user_id=?
        WHERE sf.state='active' ORDER BY s.kind, sf.name`
    ).all(claims.sub, claims.sub) as Record<string, unknown>[]
    return reply.send(ok(rows.map((row) => ({
      ...row,
      mandatory: !!row.mandatory,
      allowPersonalOverride: !!row.allowPersonalOverride,
      enabled: !!row.mandatory || !!row.enabled,
      signaturePayload: signaturePayload({
        familyId: String(row.skillId), versionId: String(row.versionId),
        version: String(row.version), hash: String(row.hash),
        scopeKind: String(row.scopeKind), mandatory: !!row.mandatory,
        allowPersonalOverride: !!row.allowPersonalOverride
      }),
      packageUrl: `/api/v1/skills/${row.skillId}/versions/${row.versionId}/package`
    }))))
  })

  app.post('/api/v1/skills/:id/publish', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = PublishSkillSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
    const claims = (req as AuthedRequest).claims
    const sourceId = (req.params as { id: string }).id
    const source = db.prepare(
      `SELECT sf.id AS skillId, sf.slug, sf.name, sf.description, sf.owner_id AS ownerId,
              sf.scope_id AS scopeId, s.kind AS scopeKind,
              sv.id AS versionId, sv.version, sv.package_key AS packageKey,
              sv.content_hash AS hash, sv.package_bytes AS packageBytes,
              sv.manifest_json AS manifestJson
         FROM skill_families sf
         JOIN v_effective_scopes s ON s.id=sf.scope_id
         JOIN skill_versions sv ON sv.id=sf.current_version_id AND sv.state='approved'
        WHERE sf.id=? AND sf.state='active'`
    ).get(sourceId) as {
      skillId: string; slug: string; name: string; description: string; ownerId: string | null
      scopeId: string; scopeKind: string; versionId: string; version: string
      packageKey: string; hash: string; packageBytes: number; manifestJson: string
    } | undefined
    const ctx = loadAccessContext(db, claims.sub)
    if (!source || source.scopeKind !== 'personal' || source.ownerId !== claims.sub ||
      !canAccessScope(ctx, source.scopeId)) {
      return reply.code(404).send(fail(4041, '个人 Skill 不存在或无权发布'))
    }
    const policy = db.prepare(
      `SELECT allow_skill_submission AS enabled FROM enterprise_policy WHERE id='default'`
    ).get() as { enabled: number } | undefined
    if (policy?.enabled === 0) return reply.code(403).send(fail(4036, '企业策略已禁用 Skill 提交'))
    const target = db.prepare('SELECT id,kind FROM v_effective_scopes WHERE id=?')
      .get(parsed.data.targetScopeId) as { id: string; kind: string } | undefined
    if (!target || target.kind === 'personal' || !canAccessScope(ctx, target.id)) {
      return reply.code(403).send(fail(4033, '只能发布到当前用户可见的团队/组织空间'))
    }
    const version = parsed.data.version ?? source.version
    let family = db.prepare(
      `SELECT id,owner_id AS ownerId FROM skill_families WHERE scope_id=? AND slug=?`
    ).get(target.id, source.slug) as { id: string; ownerId: string | null } | undefined
    if (family && family.ownerId !== claims.sub && claims.role === 'member') {
      return reply.code(409).send(fail(4094, '目标空间的同名 Skill 由其他人管理'))
    }
    const familyId = family?.id ?? randomUUID()
    if (db.prepare('SELECT 1 FROM skill_versions WHERE family_id=? AND version=?').get(familyId, version)) {
      return reply.code(409).send(fail(4095, `版本 ${version} 已存在`))
    }
    const bytes = await storage.get(source.packageKey)
    const report = await scanSkillPackage(bytes, cfg)
    const quarantineKey = await storage.put(bytes, 'zip', 'quarantine/skills')
    const now = Date.now()
    const versionId = randomUUID()
    const autoApprove = report.status === 'passed' && claims.role !== 'member'
    const packageKey = autoApprove
      ? await storage.move(quarantineKey, 'published/skills') : quarantineKey
    const signature = signServerPayload(cfg.masterKey, signaturePayload({
      familyId, versionId, version, hash: source.hash, scopeKind: target.kind,
      mandatory: false, allowPersonalOverride: true
    }))
    db.transaction(() => {
      if (!family) {
        db.prepare(
          `INSERT INTO skill_families
             (id,scope_id,slug,name,description,owner_id,state,mandatory,
              allow_personal_override,created_at,updated_at)
           VALUES (?,?,?,?,?,?,'active',0,1,?,?)`
        ).run(familyId, target.id, source.slug, source.name, source.description, claims.sub, now, now)
        family = { id: familyId, ownerId: claims.sub }
      }
      db.prepare(
        `INSERT INTO skill_versions
           (id,family_id,version,package_key,content_hash,package_bytes,manifest_json,
            signature,state,submitter_id,reviewer_id,review_note,created_at,reviewed_at,
            published_at,quarantine_package_key,published_package_key,scan_status,
            scan_report_json,changelog,scan_started_at,scan_completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        versionId, familyId, version, packageKey, source.hash, source.packageBytes,
        source.manifestJson, signature,
        report.status === 'failed' ? 'rejected' : autoApprove ? 'approved' : 'pending',
        claims.sub, autoApprove ? claims.sub : null,
        report.status === 'failed' ? scanFailure(report) : null, now,
        autoApprove || report.status === 'failed' ? now : null,
        autoApprove ? now : null, autoApprove ? null : quarantineKey,
        autoApprove ? packageKey : null, report.status, JSON.stringify(report),
        parsed.data.changelog ?? `从个人 Skill ${source.skillId}@${source.version} 发布`, now, now
      )
      if (autoApprove) {
        db.prepare('UPDATE skill_families SET current_version_id=?,updated_at=? WHERE id=?')
          .run(versionId, now, familyId)
      }
    })()
    app.audit(req, report.status === 'failed' ? 'skill_scan_failed' :
      autoApprove ? 'skill_publish' : 'skill_submit', versionId, {
      sourceSkillId: sourceId, familyId, scopeId: target.id, version
    })
    if (report.status === 'failed') {
      return reply.code(422).send(fail(4222, `Skill 技术扫描未通过: ${scanFailure(report)}`))
    }
    return reply.send(ok({
      submissionId: versionId, skillId: familyId, version,
      state: autoApprove ? 'approved' : 'pending', scanStatus: 'passed'
    }))
  })

  app.get('/api/v1/skills/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const skillId = (req.params as { id: string }).id
    const ctx = loadAccessContext(db, claims.sub)
    const family = db.prepare(
      `SELECT sf.id AS skillId, sf.scope_id AS scopeId, sf.slug, sf.name, sf.description,
              sf.state, sf.current_version_id AS currentVersionId, sf.mandatory,
              sf.allow_personal_override AS allowPersonalOverride,
              COALESCE(pref.enabled,0) AS enabled, s.kind AS scopeKind, s.name AS scopeName
         FROM skill_families sf
         JOIN v_effective_scopes s ON s.id=sf.scope_id
         LEFT JOIN skill_user_preferences pref
           ON pref.skill_id=sf.id AND pref.user_id=?
        WHERE sf.id=?`
    ).get(claims.sub, skillId) as Record<string, unknown> | undefined
    if (!family || !canAccessScope(ctx, String(family.scopeId))) {
      return reply.code(404).send(fail(4041, 'Skill 不存在或无权访问'))
    }
    const versions = db.prepare(
      `SELECT id AS versionId, version, state, content_hash AS hash,
              package_bytes AS packageBytes, changelog, scan_status AS scanStatus,
              scan_report_json AS scanReportJson, review_note AS reviewNote,
              created_at AS createdAt, published_at AS publishedAt
         FROM skill_versions WHERE family_id=? ORDER BY created_at DESC`
    ).all(skillId) as Record<string, unknown>[]
    return reply.send(ok({
      ...family,
      mandatory: !!family.mandatory,
      allowPersonalOverride: !!family.allowPersonalOverride,
      enabled: !!family.mandatory || !!family.enabled,
      versions: versions.map((version) => ({
        ...version,
        scanReport: typeof version.scanReportJson === 'string'
          ? JSON.parse(version.scanReportJson) : null,
        scanReportJson: undefined
      }))
    }))
  })

  app.put('/api/v1/skills/:id/preference', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
    const claims = (req as AuthedRequest).claims
    const skillId = (req.params as { id: string }).id
    const ctx = loadAccessContext(db, claims.sub)
    const row = db.prepare(
      `SELECT scope_id AS scopeId, mandatory FROM skill_families
        WHERE id=? AND state='active'`
    ).get(skillId) as { scopeId: string; mandatory: number } | undefined
    if (!row || !canAccessScope(ctx, row.scopeId)) {
      return reply.code(404).send(fail(4041, 'Skill 不存在或无权访问'))
    }
    if (row.mandatory && !parsed.data.enabled) {
      return reply.code(409).send(fail(4097, '强制 Skill 不能禁用'))
    }
    const now = Date.now()
    db.transaction(() => {
      db.prepare(
        `INSERT INTO skill_user_preferences(user_id, skill_id, enabled, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(user_id,skill_id) DO UPDATE
           SET enabled=excluded.enabled, updated_at=excluded.updated_at`
      ).run(claims.sub, skillId, Number(parsed.data.enabled), now)
      // 让增量同步 cursor 立即看到偏好变化；权威 visibleSkillIds
      // 仍是最终的撤权保障。
      db.prepare('UPDATE skill_families SET updated_at=? WHERE id=?').run(now, skillId)
    })()
    app.audit(req, 'skill_preference', skillId, { enabled: parsed.data.enabled })
    return reply.send(ok({ skillId, enabled: parsed.data.enabled }))
  })

  app.post('/api/v1/skills/:id/usage-events', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = z.object({
      versionId: z.string().min(1),
      sessionId: z.string().max(200).optional(),
      result: z.enum(['success', 'failed', 'cancelled']),
      durationMs: z.number().int().nonnegative().max(24 * 60 * 60_000).optional(),
      errorCode: z.string().max(100).optional()
    }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
    const claims = (req as AuthedRequest).claims
    const skillId = (req.params as { id: string }).id
    const row = versionById(app, parsed.data.versionId)
    const ctx = loadAccessContext(db, claims.sub)
    if (!row || row.familyId !== skillId || !canAccessScope(ctx, row.scopeId)) {
      return reply.code(404).send(fail(4041, 'Skill 版本不存在或无权访问'))
    }
    const id = randomUUID()
    db.prepare(
      `INSERT INTO skill_usage_events
         (id,skill_id,version_id,user_id,session_id,result,duration_ms,error_code,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(id, skillId, parsed.data.versionId, claims.sub, parsed.data.sessionId ?? null,
      parsed.data.result, parsed.data.durationMs ?? null, parsed.data.errorCode ?? null, Date.now())
    return reply.send(ok({ id }))
  })

  app.get('/api/v1/skills/sync', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const cursor = Math.max(0, Number((req.query as { cursor?: string }).cursor ?? 0) || 0)
    const nextCursor = Date.now()
    const rows = db.prepare(
      `SELECT sf.id AS skillId, sf.slug, sf.name, sf.description, sv.id AS versionId,
              sv.version, sv.content_hash AS hash, sv.signature,
              sf.mandatory, sf.allow_personal_override AS allowPersonalOverride,
              sf.updated_at AS updatedAt, s.kind AS scopeKind
         FROM skill_families sf
         JOIN skill_versions sv ON sv.id = sf.current_version_id AND sv.state='approved'
         JOIN v_effective_scopes s ON s.id = sf.scope_id
         JOIN v_user_scopes us ON us.scope_id = sf.scope_id AND us.user_id = ?
         LEFT JOIN skill_user_preferences pref
           ON pref.skill_id=sf.id AND pref.user_id=?
        WHERE sf.state='active'
          AND (sf.mandatory=1 OR COALESCE(pref.enabled,0)=1)
          AND sf.updated_at > ? AND sf.updated_at <= ?`
    ).all(claims.sub, claims.sub, cursor, nextCursor) as Record<string, unknown>[]
    const revoked = db.prepare(
      `SELECT sf.id AS skillId, sf.updated_at AS revokedAt
         FROM skill_families sf
         JOIN v_user_scopes us ON us.scope_id=sf.scope_id AND us.user_id=?
        WHERE sf.state='revoked' AND sf.updated_at > ? AND sf.updated_at <= ?`
    ).all(claims.sub, cursor, nextCursor)
    // 增量 cursor 无法单独表达“用户被移出团队”，因为该 Skill 本身
    // 并没有 updated_at 变化。每次同步附带当前权威可见 ID 集，客户端
    // 用它删除已撤权的本地包，确保在线权限收紧下一次同步生效。
    const visibleSkillIds = db.prepare(
      `SELECT sf.id AS skillId
         FROM skill_families sf
         JOIN skill_versions sv ON sv.id=sf.current_version_id AND sv.state='approved'
         JOIN v_user_scopes us ON us.scope_id=sf.scope_id AND us.user_id=?
         LEFT JOIN skill_user_preferences pref
           ON pref.skill_id=sf.id AND pref.user_id=?
        WHERE sf.state='active' AND (sf.mandatory=1 OR COALESCE(pref.enabled,0)=1)
        ORDER BY sf.id`
    ).all(claims.sub, claims.sub).map((row) => (row as { skillId: string }).skillId)
    const leaseHours = (db.prepare(
      `SELECT managed_lease_hours AS hours FROM enterprise_policy WHERE id='default'`
    ).get() as { hours: number } | undefined)?.hours ?? 24
    return reply.send(ok({
      nextCursor: String(nextCursor),
      leaseUntil: nextCursor + leaseHours * 60 * 60_000,
      visibleSkillIds,
      upserts: rows.map((row) => ({
        ...row,
        mandatory: !!row.mandatory,
        allowPersonalOverride: !!row.allowPersonalOverride,
        signaturePayload: signaturePayload({
          familyId: String(row.skillId), versionId: String(row.versionId),
          version: String(row.version), hash: String(row.hash),
          scopeKind: String(row.scopeKind), mandatory: !!row.mandatory,
          allowPersonalOverride: !!row.allowPersonalOverride
        }),
        packageUrl: `/api/v1/skills/${row.skillId}/versions/${row.versionId}/package`
      })),
      revoked
    }))
  })

  app.get('/api/v1/skills/:skillId/versions/:versionId/package', {
    preHandler: app.authenticate
  }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const { skillId, versionId } = req.params as { skillId: string; versionId: string }
    const row = versionById(app, versionId)
    const ctx = loadAccessContext(db, claims.sub)
    if (
      !row || row.familyId !== skillId || row.state !== 'approved' ||
      !canAccessScope(ctx, row.scopeId) ||
      !db.prepare(
        `SELECT 1 FROM skill_families WHERE id=? AND current_version_id=? AND state='active'`
      ).get(skillId, versionId)
    ) {
      return reply.code(404).send(fail(4041, 'Skill 不存在或无权访问'))
    }
    const buf = await storage.get(row.packageKey)
    app.audit(req, 'skill_download', skillId, { versionId })
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${row.slug}-${row.version}.zip"`)
      .header('x-echo-content-sha256', row.contentHash)
      .header('x-echo-signature', row.signature)
      .header('x-content-type-options', 'nosniff')
      .send(buf)
  })

  app.post('/api/v1/skills/:id/revoke', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    const skillId = (req.params as { id: string }).id
    const row = db.prepare(
      `SELECT sf.scope_id AS scopeId, sf.owner_id AS ownerId, s.kind AS scopeKind,
              sf.current_version_id AS versionId
         FROM skill_families sf JOIN v_effective_scopes s ON s.id=sf.scope_id
        WHERE sf.id=?`
    ).get(skillId) as {
      scopeId: string
      ownerId: string | null
      scopeKind: string
      versionId: string | null
    } | undefined
    if (!row) return reply.code(404).send(fail(4041, 'Skill 不存在'))
    const ctx = loadAccessContext(db, claims.sub)
    const allowed = claims.role === 'admin' ||
      (claims.role === 'curator' && canAccessScope(ctx, row.scopeId)) ||
      (row.scopeKind === 'personal' && row.ownerId === claims.sub)
    if (!allowed) return reply.code(403).send(fail(4034, '无权撤回该 Skill'))
    const now = Date.now()
    db.transaction(() => {
      db.prepare(
        `UPDATE skill_families SET state='revoked', current_version_id=NULL, updated_at=? WHERE id=?`
      ).run(now, skillId)
      if (row.versionId) db.prepare("UPDATE skill_versions SET state='revoked' WHERE id=?").run(row.versionId)
    })()
    app.audit(req, 'skill_revoke', skillId)
    return reply.send(ok({ state: 'revoked' }))
  })

  app.post('/api/v1/admin/skills/:id/disable', {
    preHandler: [app.authenticate, requireCurator]
  }, async (req, reply) => {
    const parsed = z.object({ note: z.string().min(1).max(2000) }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '请说明禁用原因'))
    const claims = (req as AuthedRequest).claims
    const skillId = (req.params as { id: string }).id
    const row = db.prepare(
      `SELECT scope_id AS scopeId, current_version_id AS versionId, state
         FROM skill_families WHERE id=?`
    ).get(skillId) as { scopeId: string; versionId: string | null; state: string } | undefined
    const ctx = loadAccessContext(db, claims.sub)
    if (!row || (claims.role !== 'admin' && !canAccessScope(ctx, row.scopeId))) {
      return reply.code(404).send(fail(4041, 'Skill 不存在或无权管理'))
    }
    if (row.state === 'revoked') return reply.send(ok({ state: 'disabled', dedup: true }))
    const now = Date.now()
    db.transaction(() => {
      // 保留 current_version_id 供快速恢复/回滚，state 会立即使目录、
      // 下载和同步全部失效。
      db.prepare("UPDATE skill_families SET state='revoked', updated_at=? WHERE id=?")
        .run(now, skillId)
      if (row.versionId) {
        db.prepare('UPDATE skill_versions SET review_note=COALESCE(review_note, ?) WHERE id=?')
          .run(parsed.data.note, row.versionId)
      }
    })()
    app.audit(req, 'skill_disable', skillId, { note: parsed.data.note })
    return reply.send(ok({ state: 'disabled', skillId }))
  })

  app.post('/api/v1/admin/skills/:id/rollback', {
    preHandler: [app.authenticate, requireCurator]
  }, async (req, reply) => {
    const parsed = z.object({ versionId: z.string().optional(), note: z.string().max(2000).optional() })
      .safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '参数错误'))
    const claims = (req as AuthedRequest).claims
    const skillId = (req.params as { id: string }).id
    const family = db.prepare(
      `SELECT sf.scope_id AS scopeId, sf.current_version_id AS currentVersionId,
              sf.mandatory, sf.allow_personal_override AS allowPersonalOverride,
              s.kind AS scopeKind
         FROM skill_families sf JOIN v_effective_scopes s ON s.id=sf.scope_id
        WHERE sf.id=?`
    ).get(skillId) as {
      scopeId: string
      currentVersionId: string | null
      mandatory: number
      allowPersonalOverride: number
      scopeKind: string
    } | undefined
    const ctx = loadAccessContext(db, claims.sub)
    if (!family || (claims.role !== 'admin' && !canAccessScope(ctx, family.scopeId))) {
      return reply.code(404).send(fail(4041, 'Skill 不存在或无权管理'))
    }
    const target = parsed.data.versionId
      ? db.prepare(
          `SELECT id,version,content_hash AS hash,state FROM skill_versions
            WHERE id=? AND family_id=?`
        ).get(parsed.data.versionId, skillId)
      : db.prepare(
          `SELECT id,version,content_hash AS hash,state FROM skill_versions
            WHERE family_id=? AND state='approved' AND id IS NOT ?
            ORDER BY published_at DESC, created_at DESC LIMIT 1`
        ).get(skillId, family.currentVersionId) as
          | { id: string; version: string; hash: string; state: string }
          | undefined
    const version = target as { id: string; version: string; hash: string; state: string } | undefined
    if (!version || version.state !== 'approved') {
      return reply.code(409).send(fail(4098, '没有可回滚的已发布版本'))
    }
    const signature = signServerPayload(cfg.masterKey, signaturePayload({
      familyId: skillId,
      versionId: version.id,
      version: version.version,
      hash: version.hash,
      scopeKind: family.scopeKind,
      mandatory: !!family.mandatory,
      allowPersonalOverride: !!family.allowPersonalOverride
    }))
    const now = Date.now()
    db.transaction(() => {
      db.prepare('UPDATE skill_versions SET signature=? WHERE id=?').run(signature, version.id)
      db.prepare(
        `UPDATE skill_families SET current_version_id=?, state='active', updated_at=? WHERE id=?`
      ).run(version.id, now, skillId)
    })()
    app.audit(req, 'skill_rollback', skillId, {
      fromVersionId: family.currentVersionId,
      toVersionId: version.id,
      note: parsed.data.note ?? null
    })
    return reply.send(ok({ state: 'active', skillId, versionId: version.id, version: version.version }))
  })
}
