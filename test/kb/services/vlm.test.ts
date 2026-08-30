import { describe, it, expect, vi, afterEach } from 'vitest'
import { createVlmClient } from '../../../src/kb/services/vlm.js'
import { testConfig } from '../../../src/config.js'

describe('VLM cfg 注入', () => {
  afterEach(() => vi.restoreAllMocks())

  it('cfg.vlmUrl 未设 → 明确不可用,configured=false', async () => {
    const c = createVlmClient(testConfig())
    expect(c.configured).toBe(false)
    await expect(c.caption(Buffer.from('xxx'), 'image/png')).rejects.toThrow('未配置')
  })

  it('cfg.vlmUrl 已设 → 走 fetch,configured=true,带 Bearer 鉴权', async () => {
    let captured: Record<string, string> = {}
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      h.forEach((v, k) => (captured[k] = v))
      return new Response(JSON.stringify({ caption: '看图说话的结果' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = createVlmClient(
      testConfig({
        vlmUrl: 'https://vlm.test/v1',
        vlmKey: 'sk-vlm',
        vlmModel: 'vision-prod'
      })
    )
    expect(c.configured).toBe(true)
    const text = await c.caption(Buffer.from('xxx'), 'image/png')
    expect(text).toBe('看图说话的结果')
    expect(captured.authorization).toBe('Bearer sk-vlm')
    // FormData 含 max_tokens=300 / lang=zh
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('model')).toBe('vision-prod')
    expect(c.model).toBe('vision-prod')
  })

  it('远端 5xx 抛错', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream down', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const c = createVlmClient(testConfig({ vlmUrl: 'https://vlm.test/v1' }))
    await expect(c.caption(Buffer.from('x'), 'image/png')).rejects.toThrow(/500/)
  })

  it('空 caption 抛错(占位兜底,不静默产出空索引)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ caption: '  ' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const c = createVlmClient(testConfig({ vlmUrl: 'https://vlm.test/v1' }))
    await expect(c.caption(Buffer.from('x'), 'image/png')).rejects.toThrow(/empty/)
  })

  it('caption 与 text 字段都尝试,text 兜底', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: '仅 text 字段' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const c = createVlmClient(testConfig({ vlmUrl: 'https://vlm.test/v1' }))
    const text = await c.caption(Buffer.from('x'), 'image/png')
    expect(text).toBe('仅 text 字段')
  })

  it('不配 vlmKey 时不发 Authorization 头', async () => {
    let captured: Record<string, string> = {}
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      h.forEach((v, k) => (captured[k] = v))
      return new Response(JSON.stringify({ caption: 'ok' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = createVlmClient(testConfig({ vlmUrl: 'https://vlm.test/v1' }))
    await c.caption(Buffer.from('x'), 'image/png')
    expect(captured.authorization).toBeUndefined()
  })
})

describe('VLM 兼容旧调用', () => {
  afterEach(() => vi.restoreAllMocks())

  it('不传 cfg 时回退 env', async () => {
    const prev = process.env.ECHO_VLM_URL
    delete process.env.ECHO_VLM_URL
    try {
      const c = createVlmClient()
      expect(c.configured).toBe(false)
    } finally {
      if (prev) process.env.ECHO_VLM_URL = prev
    }
  })
})
