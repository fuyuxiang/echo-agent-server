import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { testConfig } from '../src/config.js'
import { createUser } from '../src/dao/users.js'
import { openDb, type DB } from '../src/db/index.js'
import { verifyServerPayload } from '../src/server-signing.js'
import { ensureOrgScope } from '../src/server.js'

let db: DB
let app: FastifyInstance
let storageDir: string
let orgScope: string
let aliceId: string
let adminToken: string
let aliceToken: string
let bobToken: string

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, deviceId: `${username}-skills` }
  })
  return response.json().data.accessToken
}

async function skillZip(name: string, version = '1.0.0'): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    'SKILL.md',
    `---\nname: ${name}\ndescription: 使用公司规范生成客户周报\nversion: ${version}\n---\n\n# 客户周报\n\n按固定模板输出。`
  )
  zip.file('references/template.md', '# 周报模板')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function multipart(scopeId: string, zip: Buffer, version = '1.0.0') {
  const boundary = '----EchoSkillBoundary123'
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="scopeId"\r\n\r\n${scopeId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n${version}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\n` +
      'Content-Type: application/zip\r\n\r\n'
  )
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([prefix, zip, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`
  }
}

async function submit(token: string, scopeId: string, zip: Buffer, version = '1.0.0') {
  const body = multipart(scopeId, zip, version)
  return app.inject({
    method: 'POST',
    url: '/api/v1/skill-submissions',
    headers: { ...bearer(token), 'content-type': body.contentType },
    payload: body.payload
  })
}

beforeEach(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'echo-skills-'))
  db = openDb({ path: ':memory:' })
  orgScope = ensureOrgScope(db)
  await createUser(db, {
    username: 'admin',
    password: 'admin-password',
    role: 'admin',
    clearance: 2
  })
  const alice = await createUser(db, { username: 'alice', password: 'alice-password' })
  aliceId = alice.id
  await createUser(db, { username: 'bob', password: 'bob-password' })
  app = buildApp({ db, cfg: testConfig({ storageDir }), serveWeb: false })
  adminToken = await login('admin', 'admin-password')
  aliceToken = await login('alice', 'alice-password')
  bobToken = await login('bob', 'bob-password')
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(storageDir, { recursive: true, force: true })
})

describe('Skill 个人/企业发布与同步', () => {
  it('个人 Skill 自动发布且他人不可见', async () => {
    const response = await submit(aliceToken, `personal-${aliceId}`, await skillZip('weekly-report'))
    expect(response.statusCode).toBe(200)
    expect(response.json().data.state).toBe('approved')

    const mine = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: bearer(aliceToken) })
    expect(mine.json().data).toHaveLength(1)
    expect(mine.json().data[0].scopeKind).toBe('personal')

    const others = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: bearer(bobToken) })
    expect(others.json().data).toHaveLength(0)
  })

  it('组织 Skill 审核前不可见，审核后可同步、下载和验签', async () => {
    const zip = await skillZip('customer-weekly')
    const submitted = await submit(aliceToken, orgScope, zip)
    expect(submitted.json().data.state).toBe('pending')
    const versionId = submitted.json().data.submissionId

    const memberReviewDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/skill-submissions/${versionId}/package`,
      headers: bearer(bobToken)
    })
    expect(memberReviewDownload.statusCode).toBe(403)
    const reviewerDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/skill-submissions/${versionId}/package`,
      headers: bearer(adminToken)
    })
    expect(reviewerDownload.statusCode).toBe(200)
    expect(createHash('sha256').update(reviewerDownload.rawPayload).digest('hex')).toBe(
      createHash('sha256').update(zip).digest('hex')
    )

    const before = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: bearer(bobToken) })
    expect(before.json().data).toHaveLength(0)

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/skill-submissions/${versionId}/approve`,
      headers: bearer(adminToken),
      payload: { note: '已审核', mandatory: true, allowPersonalOverride: false }
    })
    expect(approved.statusCode).toBe(200)

    const sync = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    const item = sync.json().data.upserts[0]
    expect(item.name).toBe('customer-weekly')
    expect(item.mandatory).toBe(true)
    expect(item.allowPersonalOverride).toBe(false)

    const cannotDisableMandatory = await app.inject({
      method: 'PUT',
      url: `/api/v1/skills/${item.skillId}/preference`,
      headers: bearer(bobToken),
      payload: { enabled: false }
    })
    expect(cannotDisableMandatory.statusCode).toBe(409)

    const bootstrap = await app.inject({
      method: 'GET',
      url: '/api/v1/client/bootstrap',
      headers: bearer(bobToken)
    })
    expect(
      verifyServerPayload(
        bootstrap.json().data.signingPublicKey,
        item.signaturePayload,
        item.signature
      )
    ).toBe(true)

    const downloaded = await app.inject({
      method: 'GET',
      url: item.packageUrl,
      headers: bearer(bobToken)
    })
    expect(downloaded.statusCode).toBe(200)
    expect(createHash('sha256').update(downloaded.rawPayload).digest('hex')).toBe(item.hash)
    expect(downloaded.headers['x-echo-signature']).toBe(item.signature)
  })

  it('撤回后下一次同步返回 revoked，包也不再可下载', async () => {
    const published = await submit(adminToken, orgScope, await skillZip('incident-guide'))
    const list = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: bearer(bobToken) })
    const item = list.json().data[0]

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/skills/${published.json().data.skillId}/revoke`,
      headers: bearer(adminToken)
    })
    expect(revoked.statusCode).toBe(200)
    const sync = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    expect(sync.json().data.revoked[0].skillId).toBe(published.json().data.skillId)

    const download = await app.inject({
      method: 'GET',
      url: item.packageUrl,
      headers: bearer(bobToken)
    })
    expect(download.statusCode).toBe(404)
  })

  it('非强制 Skill 的个人偏好会立即收紧并恢复同步清单', async () => {
    const published = await submit(adminToken, orgScope, await skillZip('optional-guide'))
    const skillId = published.json().data.skillId

    const catalog = await app.inject({
      method: 'GET',
      url: '/api/v1/skills',
      headers: bearer(bobToken)
    })
    expect(catalog.json().data.find((item: { skillId: string }) => item.skillId === skillId).enabled)
      .toBe(false)

    const beforeInstall = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    expect(beforeInstall.json().data.visibleSkillIds).not.toContain(skillId)
    expect(beforeInstall.json().data.upserts).toHaveLength(0)

    const disabled = await app.inject({
      method: 'PUT',
      url: `/api/v1/skills/${skillId}/preference`,
      headers: bearer(bobToken),
      payload: { enabled: false }
    })
    expect(disabled.statusCode).toBe(200)

    const afterDisable = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    expect(afterDisable.json().data.visibleSkillIds).not.toContain(skillId)
    expect(afterDisable.json().data.upserts).toHaveLength(0)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/skills/${skillId}`,
      headers: bearer(bobToken)
    })
    expect(detail.json().data.enabled).toBe(false)

    const enabled = await app.inject({
      method: 'PUT',
      url: `/api/v1/skills/${skillId}/preference`,
      headers: bearer(bobToken),
      payload: { enabled: true }
    })
    expect(enabled.statusCode).toBe(200)
    const afterEnable = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    expect(afterEnable.json().data.visibleSkillIds).toContain(skillId)
    expect(afterEnable.json().data.upserts[0].skillId).toBe(skillId)
  })

  it('管理员可回滚到上一个已签名版本，并可立即全局禁用', async () => {
    const first = await submit(
      adminToken,
      orgScope,
      await skillZip('rollback-guide', '1.0.0'),
      '1.0.0'
    )
    const skillId = first.json().data.skillId
    const second = await submit(
      adminToken,
      orgScope,
      await skillZip('rollback-guide', '2.0.0'),
      '2.0.0'
    )
    expect(second.json().data.skillId).toBe(skillId)

    await app.inject({
      method: 'PUT',
      url: `/api/v1/skills/${skillId}/preference`,
      headers: bearer(bobToken),
      payload: { enabled: true }
    })

    const beforeRollback = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    expect(beforeRollback.json().data.upserts[0].version).toBe('2.0.0')

    const rolledBack = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/skills/${skillId}/rollback`,
      headers: bearer(adminToken),
      payload: { note: '版本 2 验收失败' }
    })
    expect(rolledBack.statusCode).toBe(200)
    expect(rolledBack.json().data.version).toBe('1.0.0')

    const afterRollback = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    const item = afterRollback.json().data.upserts[0]
    expect(item.version).toBe('1.0.0')
    expect(
      verifyServerPayload(
        (await app.inject({
          method: 'GET', url: '/api/v1/client/bootstrap', headers: bearer(bobToken)
        })).json().data.signingPublicKey,
        item.signaturePayload,
        item.signature
      )
    ).toBe(true)

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/skills/${skillId}/disable`,
      headers: bearer(adminToken),
      payload: { note: '安全应急禁用' }
    })
    expect(disabled.statusCode).toBe(200)
    const afterDisable = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    expect(afterDisable.json().data.visibleSkillIds).not.toContain(skillId)
    const packageAfterDisable = await app.inject({
      method: 'GET',
      url: item.packageUrl,
      headers: bearer(bobToken)
    })
    expect(packageAfterDisable.statusCode).toBe(404)
  })

  it('用户被移出团队后，同步的权威清单立即移除该团队 Skill', async () => {
    db.prepare(
      "INSERT INTO groups (id, name, created_at) VALUES ('team-skill-group', '客户成功组', ?)"
    ).run(Date.now())
    db.prepare(
      "INSERT INTO scopes (id, kind, group_id, name) VALUES ('team-skill-scope', 'team', 'team-skill-group', '客户成功组')"
    ).run()
    const bobId = (db.prepare("SELECT id FROM users WHERE username='bob'").get() as { id: string }).id
    db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?,?)').run(aliceId, 'team-skill-group')
    db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?,?)').run(bobId, 'team-skill-group')

    const submitted = await submit(aliceToken, 'team-skill-scope', await skillZip('team-playbook'))
    const versionId = submitted.json().data.submissionId
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/skill-submissions/${versionId}/approve`,
      headers: bearer(adminToken),
      payload: {}
    })
    expect(approved.statusCode).toBe(200)

    const skillId = submitted.json().data.skillId
    await app.inject({
      method: 'PUT',
      url: `/api/v1/skills/${skillId}/preference`,
      headers: bearer(bobToken),
      payload: { enabled: true }
    })

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/sync?cursor=0',
      headers: bearer(bobToken)
    })
    expect(first.json().data.visibleSkillIds).toContain(skillId)
    const cursor = first.json().data.nextCursor

    db.prepare('DELETE FROM user_groups WHERE user_id=? AND group_id=?').run(bobId, 'team-skill-group')
    const afterRemoval = await app.inject({
      method: 'GET',
      url: `/api/v1/skills/sync?cursor=${encodeURIComponent(cursor)}`,
      headers: bearer(bobToken)
    })
    expect(afterRemoval.json().data.upserts).toHaveLength(0)
    expect(afterRemoval.json().data.visibleSkillIds).not.toContain(skillId)

    const oldPackageUrl = first.json().data.upserts[0].packageUrl
    const download = await app.inject({ method: 'GET', url: oldPackageUrl, headers: bearer(bobToken) })
    expect(download.statusCode).toBe(404)
  })

  it('拒绝重复 YAML 键和多入口 Skill 包', async () => {
    const duplicateYaml = new JSZip()
    duplicateYaml.file(
      'SKILL.md',
      '---\nname: safe-name\nname: shadow-name\ndescription: duplicate key\nversion: 1.0.0\n---\n'
    )
    const duplicateResponse = await submit(
      aliceToken,
      `personal-${aliceId}`,
      await duplicateYaml.generateAsync({ type: 'nodebuffer' })
    )
    expect(duplicateResponse.statusCode).toBe(400)
    expect(duplicateResponse.json().msg).toContain('YAML frontmatter')

    const multipleEntries = new JSZip()
    multipleEntries.file(
      'SKILL.md',
      '---\nname: safe-name\ndescription: safe package\nversion: 1.0.0\n---\n'
    )
    multipleEntries.file('nested/SKILL.md', '# hidden second entry')
    const multipleResponse = await submit(
      aliceToken,
      `personal-${aliceId}`,
      await multipleEntries.generateAsync({ type: 'nodebuffer' })
    )
    expect(multipleResponse.statusCode).toBe(400)
    expect(multipleResponse.json().msg).toContain('只能包含一个 SKILL.md')
  })
})
