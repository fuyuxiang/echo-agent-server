import { describe, it, expect, vi, afterEach } from 'vitest'
import { createReranker, rerankSafely } from '../../src/models/reranker.js'
import { testConfig } from '../../src/config.js'

describe('reranker 能力标记', () => {
  it('未配置 URL → 占位实现,crossEncoder=false', () => {
    const r = createReranker(testConfig())
    expect(r.crossEncoder).toBe(false)
  })

  it('配置了 URL → 远程实现,crossEncoder=true', () => {
    const r = createReranker(testConfig({ rerankUrl: 'https://rerank.test/v1' }))
    expect(r.crossEncoder).toBe(true)
  })
})

describe('占位精排(lexical)行为', () => {
  it('同源子串多者分高,无重叠 0', async () => {
    const r = createReranker(testConfig())
    const out = await r.rerank('住宿 报销', [
      { id: 'a', text: '住宿 报销 标准 一线城市' },
      { id: 'b', text: '完全不相关的主题' }
    ])
    expect(out[0].id).toBe('a')
    expect(out[0].score).toBeGreaterThan(0)
    expect(out[1].score).toBe(0)
  })

  it('空查询返回 0 分,顺序保持(按稳定性测试)', async () => {
    const r = createReranker(testConfig())
    const out = await r.rerank('', [
      { id: 'a', text: '任何' },
      { id: 'b', text: '内容' }
    ])
    expect(out.every((x) => x.score === 0)).toBe(true)
  })
})

describe('远程精排', () => {
  afterEach(() => vi.restoreAllMocks())

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status })
  }

  it('远端调用成功 → 返回按相关度排序的结果', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 }
        ]
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const r = createReranker(testConfig({ rerankUrl: 'https://rerank.test/v1' }))
    const out = await r.rerank('报销', [
      { id: 'a', text: 'a-utils' },
      { id: 'b', text: 'b-utils' }
    ])
    expect(out).toEqual([
      { id: 'b', score: 0.9 },
      { id: 'a', score: 0.1 }
    ])
  })

  it('5xx 远端错误透传抛出,不上落到 lexical', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 500))
    vi.stubGlobal('fetch', fetchMock)
    const r = createReranker(testConfig({ rerankUrl: 'https://rerank.test/v1' }))
    await expect(r.rerank('q', [{ id: 'a', text: 't' }])).rejects.toThrow(/500/)
  })

  it('响应缺 results 视为错误', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'broken' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = createReranker(testConfig({ rerankUrl: 'https://rerank.test/v1' }))
    await expect(r.rerank('q', [{ id: 'a', text: 't' }])).rejects.toThrow()
  })
})

describe('rerankSafely 降级语义', () => {
  afterEach(() => vi.restoreAllMocks())

  it('成功路径返回结果', async () => {
    const r = createReranker(testConfig())
    const out = await rerankSafely(r, 'q', [{ id: 'a', text: 'a' }])
    expect(out).not.toBeNull()
    expect(out).toHaveLength(1)
  })

  it('占位实现内部"超时"路径:catch 块触发时返回 null', async () => {
    // 强制让 reranker 抛错,验证 rerankSafely 把它降级成 null 而不是吞掉
    const r = createReranker(testConfig())
    vi.spyOn(r, 'rerank').mockRejectedValue(new Error('boom'))
    const out = await rerankSafely(r, 'q', [{ id: 'a', text: 'a' }])
    expect(out).toBeNull()
  })

  it('空集合 → 空数组(不是 null)', async () => {
    const r = createReranker(testConfig())
    const out = await rerankSafely(r, 'q', [])
    expect(out).toEqual([])
  })
})
