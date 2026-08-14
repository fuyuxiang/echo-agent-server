import type { Config } from '../config.js'

export interface RerankItem {
  id: string
  text: string
}

export interface RerankResult {
  id: string
  score: number
}

export interface Reranker {
  readonly model: string
  /** 返回按相关度降序的结果。抛错由调用方降级处理。 */
  rerank(query: string, items: RerankItem[]): Promise<RerankResult[]>
}

// 精排是准确率从"能用"到"可信"的分界,但它绝不能成为可用性的单点。
// 超过这个预算就放弃精排,用 RRF 顺序返回 —— 慢答案比无答案好,
// 而无精排的答案仍然可用(只是排序略差)。
export const RERANK_TIMEOUT_MS = 300

class RemoteReranker implements Reranker {
  constructor(
    readonly model: string,
    private url: string,
    private key?: string
  ) {}

  async rerank(query: string, items: RerankItem[]): Promise<RerankResult[]> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.key ? { authorization: `Bearer ${this.key}` } : {})
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: items.map((i) => i.text)
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS * 4)
    })
    if (!res.ok) {
      throw new Error(`rerank API ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = (await res.json()) as {
      results: { index: number; relevance_score: number }[]
    }
    return json.results.map((r) => ({
      id: items[r.index].id,
      score: r.relevance_score
    }))
  }
}

/**
 * 词汇重叠打分。不是交叉编码器,只是个可用的占位实现。
 *
 * 与 hash 嵌入同理:让链路在没有模型文件时也能跑通、能测试。真实精排
 * 需要 bge-reranker-v2-m3 这类 cross-encoder,配 ECHO_RERANK_URL 或
 * 本地 ONNX。方案里标了必须实测目标机器上 100 对的耗时 —— 超 200ms
 * 就得换 base 版或改远端。
 */
export function lexicalOverlapScore(query: string, text: string): number {
  const q = new Set(gram2(query))
  if (q.size === 0) return 0
  const t = new Set(gram2(text))
  let hit = 0
  for (const g of q) if (t.has(g)) hit++
  return hit / q.size
}

function gram2(s: string): string[] {
  const norm = s.toLowerCase().replace(/\s+/g, '')
  const out: string[] = []
  for (let i = 0; i < norm.length - 1; i++) out.push(norm.slice(i, i + 2))
  return out
}

class LexicalReranker implements Reranker {
  readonly model = 'lexical-dev'
  async rerank(query: string, items: RerankItem[]): Promise<RerankResult[]> {
    return items
      .map((i) => ({ id: i.id, score: lexicalOverlapScore(query, i.text) }))
      .sort((a, b) => b.score - a.score)
  }
}

export function createReranker(cfg: Config, warn?: (m: string) => void): Reranker {
  if (cfg.rerankUrl) {
    return new RemoteReranker(cfg.rerankModel, cfg.rerankUrl, cfg.rerankKey)
  }
  warn?.(
    '未配置 ECHO_RERANK_URL,回退到词汇重叠打分 —— 非交叉编码器,准确率显著低于生产配置'
  )
  return new LexicalReranker()
}

/**
 * 带超时与降级的精排。
 *
 * 任何失败都返回 null,调用方据此保留 RRF 顺序并在 diagnostics 里
 * 标记 rerankSkipped —— 检索绝不因精排失败而失败。
 */
export async function rerankSafely(
  reranker: Reranker,
  query: string,
  items: RerankItem[],
  timeoutMs = RERANK_TIMEOUT_MS,
  onError?: (e: unknown) => void
): Promise<RerankResult[] | null> {
  if (items.length === 0) return []
  try {
    return await Promise.race([
      reranker.rerank(query, items),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`rerank timeout ${timeoutMs}ms`)), timeoutMs)
      )
    ])
  } catch (e) {
    onError?.(e)
    return null
  }
}
