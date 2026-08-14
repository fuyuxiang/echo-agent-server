import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEmbedder } from '../../src/models/embedder.js'
import { testConfig } from '../../src/config.js'

// semantic/crossEncoder 这两个标记是真实模型与占位实现之间的关键差异,
// 不只是运行差异 —— 它决定 admin 端能否一眼看出系统是否在用真实能力。
// 这两行断言就是它们的看门狗:有人想偷偷把 semantic 永远写成 true,这两个
// 测试会立刻挂。
describe('嵌入器的能力标记', () => {
  it('未配置 URL → 占位实现,semantic=false', () => {
    const e = createEmbedder(testConfig())
    expect(e.semantic).toBe(false)
  })

  it('配置了 URL → 远程实现,semantic=true', () => {
    const e = createEmbedder(
      testConfig({ embedUrl: 'https://embed.test/v1', embedDim: 1024 })
    )
    expect(e.semantic).toBe(true)
  })

  it('精排同理:占位实现 crossEncoder=false', async () => {
    const { createReranker } = await import('../../src/models/reranker.js')
    const r = createReranker(testConfig())
    expect(r.crossEncoder).toBe(false)
  })
})

describe('占位嵌入', () => {
  it('未配置 URL 时使用 hash 伪嵌入', () => {
    const e = createEmbedder(testConfig())
    expect(e.model).toBe('hash-dev')
  })

  it('相同输入产生相同向量(可复现)', async () => {
    const e = createEmbedder(testConfig())
    expect(await e.embed('报销 审批')).toEqual(await e.embed('报销 审批'))
  })

  it('不同输入产生不同向量(单位化后内积小)', async () => {
    const e = createEmbedder(testConfig({ embedDim: 16 }))
    const a = await e.embed('差旅住宿')
    const b = await e.embed('数据库索引')
    let dot = 0
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
    expect(Math.abs(dot)).toBeLessThan(0.5)
  })

  it('向量维度等于配置', async () => {
    const e = createEmbedder(testConfig({ embedDim: 1024 }))
    expect((await e.embed('x')).length).toBe(1024)
  })
})

describe('真实嵌入的错误处理', () => {
  afterEach(() => vi.restoreAllMocks())

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status })
  }

  it('维度不符立即报错且不重试(配置错误,重试无意义)', async () => {
    const fetchMock = vi
      .fn(async () =>
        jsonResponse({ data: [{ embedding: new Array(512).fill(0.01) }] })
      )
    vi.stubGlobal('fetch', fetchMock)
    const e = createEmbedder(
      testConfig({ embedUrl: 'https://embed.test/v1', embedDim: 1024 })
    )
    await expect(e.embedBatch(['x'])).rejects.toThrow(/维度不符/)
    // 维度错是配置错,重试也是同样错,不该浪费 3 次请求
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('限流(429)自动重试至上限', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls < 3) return jsonResponse({}, 429)
      return jsonResponse({ data: [{ embedding: new Array(1024).fill(0.01) }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const e = createEmbedder(
      testConfig({ embedUrl: 'https://embed.test/v1', embedDim: 1024 })
    )
    const v = await e.embedBatch(['x'])
    expect(v).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('请求数与返回数不符立即报错(否则向量错位)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const e = createEmbedder(
      testConfig({ embedUrl: 'https://embed.test/v1', embedDim: 1024 })
    )
    await expect(e.embedBatch(['x', 'y'])).rejects.toThrow(/数量不符/)
  })

  it('响应缺 data 数组视为错误', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'broken' }))
    vi.stubGlobal('fetch', fetchMock)
    const e = createEmbedder(
      testConfig({ embedUrl: 'https://embed.test/v1', embedDim: 1024 })
    )
    await expect(e.embedBatch(['x'])).rejects.toThrow(/data/)
  })

  it('带 Bearer 鉴权', async () => {
    let captured: Record<string, string> = {}
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      h.forEach((v, k) => (captured[k] = v))
      return jsonResponse({ data: [{ embedding: new Array(1024).fill(0.01) }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const e = createEmbedder(
      testConfig({
        embedUrl: 'https://embed.test/v1',
        embedDim: 1024,
        embedKey: 'sk-test'
      })
    )
    await e.embedBatch(['x'])
    expect(captured.authorization).toBe('Bearer sk-test')
  })
})
