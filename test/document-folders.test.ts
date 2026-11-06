import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { openDb, migrate, type DB } from '../src/db/index.js'
import { buildApp } from '../src/app.js'
import { testConfig } from '../src/config.js'
import { createUser } from '../src/dao/users.js'
import { createDocumentFamily, activateDocumentVersion } from '../src/dao/documents.js'
import { ensureOrgScope } from '../src/server.js'
import { processPublication } from '../src/operations/automatic-publication.js'
import { createEmbedder } from '../src/models/embedder.js'
import { drain } from '../src/kb/ingest/worker.js'

let db: DB, app: FastifyInstance, directory: string, scope: string, userId: string, token: string
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'echo-folders-'))
  db = openDb({ path: ':memory:' }); scope = ensureOrgScope(db)
  const user = await createUser(db, { username: 'alice', password: 'folder-password', clearance: 1 }); userId = user.id
  app = buildApp({ db, cfg: testConfig({ storageDir: directory }), serveWeb: false })
  token = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'folder-password', deviceId: 'folder-tests' } })).json().data.accessToken
})
afterEach(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })
const auth = () => ({ authorization: `Bearer ${token}` })
const browse = (params: Record<string, string | number> = {}) => app.inject({ url: '/api/v1/knowledge/library?' + new URLSearchParams({ resource: 'documents', folderId: 'root', ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) }), headers: auth() })
const folders = (paths: string[], scopeId = scope, parentFolderId?: string) => app.inject({ method: 'POST', url: '/api/v1/document-folders/import', headers: auth(), payload: { scopeId, paths, parentFolderId } })
function document(id: string, folderId: string | null = null, sensitivity = 0) {
  const family = createDocumentFamily(db, { scopeId: scope, folderId, title: id, ownerId: userId })
  db.prepare("INSERT INTO documents(id,family_id,scope_id,title,source_type,content_hash,status,sensitivity,owner_id,created_at,updated_at) VALUES (?,?,?,?,'md',?,'ready',?,?,1,1)").run(id, family, scope, id, id, sensitivity, userId)
  activateDocumentVersion(db, id)
}
function upload(content: string, folderId?: string, url = '/api/v1/document-submissions', title = '说明.md') {
  const boundary = '----EchoFolderBoundary'
  const fields: Record<string, string> = { scopeId: scope, title, ...(folderId ? { folderId } : {}) }
  const body = Object.entries(fields).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('') +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="说明.md"\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--${boundary}--\r\n`
  return app.inject({ method: 'POST', url, headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.from(body) })
}

describe('文档目录上传与兼容', () => {
  it('保留根目录、嵌套及空目录，重复导入复用目录，非法路径整批回滚', async () => {
    const first = await folders(['项目资料', '项目资料/设计', '项目资料/空目录'])
    expect(first.statusCode).toBe(200)
    const entries = first.json().data.folders
    expect(entries.map((entry: { path: string }) => entry.path)).toEqual(['项目资料', '项目资料/设计', '项目资料/空目录'])
    expect((await folders(['项目资料/设计'])).json().data.folders).toEqual(entries.slice(0, 2))
    expect((await browse()).json().data).toMatchObject({ supportsFolders: true, documentTotal: 0, folderTotal: 1, total: 1 })
    const nested = (await browse({ scopeId: scope, folderId: entries[0].id })).json().data
    expect(nested.folders).toHaveLength(2); expect(nested.breadcrumbs.map((item: { name: string }) => item.name)).toEqual(['项目资料'])
    for (const path of ['../越界', '/绝对路径', 'a\\b', 'a//b', 'a/./b', 'a/\u0000b', Array(10).fill('a').join('/')]) {
      expect((await folders(['新建目录', path])).statusCode).toBe(400)
      expect(db.prepare("SELECT id FROM document_folders WHERE name='新建目录'").get()).toBeUndefined()
    }
  })

  it('相同内容在不同目录保留独立入口，同一目录重传去重，更新版本保留目录', async () => {
    const entries = (await folders(['项目/设计', '项目/交付'])).json().data.folders
    const design = entries.find((item: { path: string }) => item.path === '项目/设计').id
    const delivery = entries.find((item: { path: string }) => item.path === '项目/交付').id
    const content = '# 文档目录\n\n相同内容应当可以放在不同目录。'
    const first = await upload(content, design)
    const second = await upload(content, delivery)
    const root = await upload(content)
    expect(first.json().data.docId).toBeTruthy(); expect(second.json().data.docId).toBeTruthy(); expect(root.json().data.docId).toBeTruthy()
    expect(new Set([first, second, root].map(result => result.json().data.docId)).size).toBe(3)
    expect((await upload(content, design)).json().data.dedup).toBe(true)
    expect((await upload(content, design, undefined, '另一份.md')).json().data.docId).toBeTruthy()
    expect((await upload('# 不同内容', design)).statusCode).toBe(409)
    await drain({ db, cfg: app.deps.cfg, embedder: createEmbedder(app.deps.cfg) })
    const version = await upload('# 新版本\n\n目录不变。', undefined, `/api/v1/docs/${first.json().data.docId}/new-version`)
    expect(version.statusCode).toBe(200)
    const list = (await browse({ folderId: design, scopeId: scope })).json().data
    expect(list.items.every((item: { folderId: string; folderPath: string }) => item.folderId === design && item.folderPath === '项目/设计')).toBe(true)
    expect(list.breadcrumbs.map((item: { name: string }) => item.name)).toEqual(['项目', '设计'])
    const search = (await browse({ q: '说明', scopeId: scope })).json().data
    expect(search.folders).toEqual([]); expect(search.items.some((item: { folderPath: string }) => item.folderPath === '项目/交付')).toBe(true)
  })

  it('文件夹和文档共同分页，目录优先且跨页不重复、不遗漏，旧接口仍平铺', async () => {
    const imported = (await folders(['A', 'B', 'C'])).json().data.folders
    for (let index = 0; index < 4; index++) document(`根文档${index}`)
    document('子目录文档', imported[0].id)
    const seen: string[] = []
    for (let page = 1; page <= 4; page++) {
      const result = (await browse({ page, size: 2 })).json().data
      expect(result.total).toBe(7); expect(result.documentTotal).toBe(4)
      expect(result.folders.length + result.items.length).toBe(page === 4 ? 1 : 2)
      seen.push(...result.folders.map((entry: { id: string }) => entry.id), ...result.items.map((entry: { id: string }) => entry.id))
    }
    expect(new Set(seen).size).toBe(7)
    const old = await app.inject({ url: '/api/v1/knowledge/library?resource=documents', headers: auth() })
    expect(old.json().data.total).toBe(5); expect(old.json().data.supportsFolders).toBeUndefined()
  })

  it('目录查询、上传及创建遵守范围权限和密级，不允许跨范围挂载', async () => {
    const own = `personal-${userId}`
    const privateFolder = (await folders(['私人目录'], own)).json().data.folders[0].id
    expect((await upload('# 测试', privateFolder)).statusCode).toBe(404)
    expect((await folders(['错误挂载'], scope, privateFolder)).statusCode).toBe(404)
    expect((await browse({ scopeId: scope, folderId: privateFolder })).statusCode).toBe(404)
    const shared = (await folders(['共享'])).json().data.folders[0].id
    document('公开文档', shared); document('高密级文档', shared, 2)
    expect((await browse({ folderId: shared })).json().data.documentTotal).toBe(1)
    await createUser(db, { username: 'bob', password: 'folder-password' })
    token = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'bob', password: 'folder-password', deviceId: 'bob' } })).json().data.accessToken
    expect((await browse({ folderId: privateFolder })).statusCode).toBe(404)
    expect((await folders(['窃取'], own)).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/knowledge/library?resource=documents&folderId=root' })).statusCode).toBe(401)
  })

  it('自动重试发布保留目录，其他目录的同内容文档不吞掉新入口', async () => {
    const entries = (await folders(['原件', '副本'])).json().data.folders
    const content = '# 重试发布\n\n保留目标目录。'
    await upload(content, entries[0].id)
    const bytes = Buffer.from(content), key = await app.deps.storage.put(bytes, 'md', 'quarantine/documents')
    db.prepare("INSERT INTO document_submissions(id,submitter_id,target_scope,title,source_type,storage_key,quarantine_storage_key,content_hash,byte_size,state,folder_id,created_at) VALUES ('retry',?,?,'说明.md','md',?,?,?,?,'pending',?,1)")
      .run(userId, scope, key, key, createHash('sha256').update(bytes).digest('hex'), bytes.length, entries[1].id)
    expect((await processPublication(app, 'document', 'retry')).state).toBe('approved')
    expect((await browse({ folderId: entries[1].id })).json().data.items).toHaveLength(1)
  })

  it('从旧数据库升级后所有历史文档保持在根目录，标题和版本不变', () => {
    const legacy = openDb({ path: ':memory:', skipMigrate: true })
    const migrationDir = join(import.meta.dirname, '../src/db/migrations')
    const scripts = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()
    for (const name of scripts.slice(0, -1)) legacy.exec(readFileSync(join(migrationDir, name), 'utf8'))
    legacy.pragma(`user_version = ${scripts.length - 1}`)
    const legacyScope = ensureOrgScope(legacy)
    legacy.prepare("INSERT INTO document_families(id,scope_id,canonical_title,state,created_at,updated_at) VALUES ('legacy-family',?,'旧标题/不拆目录','active',1,1)").run(legacyScope)
    legacy.prepare("INSERT INTO documents(id,family_id,scope_id,title,source_type,content_hash,status,version,created_at,updated_at) VALUES ('legacy','legacy-family',?,'旧标题/不拆目录','md','legacy','ready',3,1,1)").run(legacyScope)
    migrate(legacy)
    expect(legacy.prepare('SELECT title,version FROM documents WHERE id=\'legacy\'').get()).toEqual({ title: '旧标题/不拆目录', version: 3 })
    expect(legacy.prepare('SELECT folder_id FROM document_families').get()).toEqual({ folder_id: null })
    expect(legacy.prepare('SELECT COUNT(*) AS n FROM document_folders').get()).toEqual({ n: 0 })
    legacy.close()
  })
})
