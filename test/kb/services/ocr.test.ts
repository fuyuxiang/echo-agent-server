import { describe, it, expect, vi, afterEach } from 'vitest'
import { createOcrClient } from '../../../src/kb/services/ocr.js'
import { testConfig } from '../../../src/config.js'

describe('OCR cfg 注入', () => {
  it('cfg.ocrUrl 未设 → 明确不可用,configured=false', async () => {
    const c = createOcrClient(testConfig())
    expect(c.configured).toBe(false)
    await expect(c.extractFromImage(Buffer.from('xxx'))).rejects.toThrow('未配置')
  })

  it('cfg.ocrUrl 已设 → 走 fetch,configured=true', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'OCR 抽取的文本' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const c = createOcrClient(testConfig({
      ocrUrl: 'https://ocr.test/v1',
      ocrKey: 'ocr-secret'
    }))
    expect(c.configured).toBe(true)
    const text = await c.extractFromImage(Buffer.from('xxx'))
    expect(text).toBe('OCR 抽取的文本')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // POST + multipart
    const calls = fetchMock.mock.calls[0]
    expect(calls[0]).toBe('https://ocr.test/v1')
    const init = calls[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ authorization: 'Bearer ocr-secret' })
    expect(init.body).toBeInstanceOf(FormData)
  })

  it('远端 5xx 抛错,不吞(上层决定降级)', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream down', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    const c = createOcrClient(testConfig({ ocrUrl: 'https://ocr.test/v1' }))
    await expect(c.extractFromImage(Buffer.from('x'))).rejects.toThrow(/502/)
  })

  afterEach(() => vi.restoreAllMocks())
})

describe('OCR 兼容旧调用', () => {
  it('不传 cfg 时回退到 env;未配 env → 占位', async () => {
    const prev = process.env.ECHO_OCR_URL
    delete process.env.ECHO_OCR_URL
    try {
      const c = createOcrClient()
      expect(c.configured).toBe(false)
    } finally {
      if (prev) process.env.ECHO_OCR_URL = prev
    }
  })

  it('不传 cfg 时若 env 已设 → 走 fetch', async () => {
    const prev = process.env.ECHO_OCR_URL
    process.env.ECHO_OCR_URL = 'https://ocr-env.test/v1'
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'env-based' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const c = createOcrClient()
      expect(c.configured).toBe(true)
      const text = await c.extractFromImage(Buffer.from('xxx'))
      expect(text).toBe('env-based')
    } finally {
      if (prev) process.env.ECHO_OCR_URL = prev
      else delete process.env.ECHO_OCR_URL
      vi.restoreAllMocks()
    }
  })
})
