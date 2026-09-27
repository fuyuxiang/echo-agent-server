import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/db/index.js'
import { testConfig } from '../../src/config.js'
import { buildApp } from '../../src/app.js'
import { createUser } from '../../src/dao/users.js'
import { ensureOrgScope } from '../../src/server.js'
import { drain } from '../../src/kb/ingest/worker.js'

describe('多模态上传到索引', () => {
  it('图片通过上传、扫描、解析后生成可检索的 caption chunk', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'echo-multimodal-ingest-'))
    const db = openDb({ path: ':memory:' })
    const cfg = testConfig({ storageDir })
    const scopeId = ensureOrgScope(db)
    await createUser(db, { username: 'admin', password: 'admin-password', role: 'admin', clearance: 2 })
    const app = buildApp({ db, cfg, serveWeb: false, overrides: {
      vlmClient: { configured: true, model: 'MiniMax-M3', async caption() { return '图中写着 ECHO 12345' } }
    } })
    try {
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { username: 'admin', password: 'admin-password', deviceId: 'test' } })
      const token = login.json().data.accessToken as string
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlYBEkAAAAASUVORK5CYII=', 'base64')
      const boundary = 'echo-multimodal-test'
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="scopeId"\r\n\r\n${scopeId}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n`),
        image,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ])
      const upload = await app.inject({ method: 'POST', url: '/api/v1/docs/upload',
        headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
      expect(upload.statusCode).toBe(200)
      const id = upload.json().data.docId as string
      await drain({ db, cfg, embedder: app.deps.embedder, vlmClient: app.deps.vlmClient })
      expect(db.prepare('SELECT status FROM documents WHERE id=?').get(id)).toMatchObject({ status: 'ready' })
      expect(db.prepare('SELECT text,modality FROM chunks WHERE doc_id=?').get(id))
        .toMatchObject({ text: '图中写着 ECHO 12345', modality: 'caption' })
    } finally {
      await app.close()
      db.close()
      rmSync(storageDir, { recursive: true, force: true })
    }
  })
})
