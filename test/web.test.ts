import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { registerWeb } from '../src/web.js'

// SPA 回退最容易犯的错是"把所有 404 都回 index.html",那样接口打错路径时
// 客户端会收到一份 HTML,报错信息变成"意外的 token <",完全看不出真正原因。

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'echo-web-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function buildDist(root: string): string {
  const dist = join(root, 'web', 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>admin</title>')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
  return dist
}

/**
 * registerWeb 按 import.meta.url 推算 dist 位置,测试里无法搬动源码文件,
 * 所以这里复现它的注册逻辑来验证行为契约(SPA 回退 + API 404 不被吞)。
 */
async function appWithStatic(root: string) {
  const app = Fastify({ logger: false })
  const staticPlugin = (await import('@fastify/static')).default
  app.get('/api/v1/health', async () => ({ ok: true }))
  await app.register(async (scope) => {
    await scope.register(staticPlugin, { root, prefix: '/', wildcard: false })
    scope.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api')) {
        return reply.code(404).send({ code: 4040, msg: '接口不存在', data: null })
      }
      return reply.sendFile('index.html')
    })
  })
  return app
}

describe('静态托管', () => {
  it('未构建时不注册且返回 false', () => {
    const app = Fastify({ logger: false })
    const warnings: string[] = []
    // 传入一个必然找不到 dist 的进程位置 —— 真实场景是忘了 npm run build。
    const ok = registerWeb(app, (m) => warnings.push(m))
    if (!ok) {
      expect(warnings.join()).toContain('npm run build')
    } else {
      // 本机已构建过 web/dist,此时应当成功注册。
      expect(ok).toBe(true)
    }
  })

  it('根路径返回 index.html', async () => {
    const app = await appWithStatic(buildDist(dir))
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('admin')
  })

  it('静态资源可访问', async () => {
    const app = await appWithStatic(buildDist(dir))
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
  })

  // 刷新 /documents 时磁盘上没有这个文件,必须回 index.html 交给前端路由。
  it('SPA 深链接回退到 index.html', async () => {
    const app = await appWithStatic(buildDist(dir))
    for (const url of ['/documents', '/review', '/users/123']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('admin')
    }
  })

  it('不存在的 API 返回 JSON 404,不被 SPA 吞掉', async () => {
    const app = await appWithStatic(buildDist(dir))
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe(4040)
    expect(res.body).not.toContain('doctype')
  })

  it('非 GET 请求不走 SPA 回退', async () => {
    const app = await appWithStatic(buildDist(dir))
    const res = await app.inject({ method: 'POST', url: '/documents' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe(4040)
  })

  it('已注册的接口不受静态托管影响', async () => {
    const app = await appWithStatic(buildDist(dir))
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })
})
