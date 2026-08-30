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
  /**
   * 是否为真正的交叉编码器。
   *
   * 词汇重叠打分只看字面重合,"住宿标准"与"住宿费用上限"的相关性它判不出来。
   * 精排是准确率从"能用"到"可信"的分界,跑在占位实现上等于没有这一步。
   */
  readonly crossEncoder: boolean
  /** 返回按相关度降序的结果。抛错由调用方降级处理。 */
  rerank(query: string, items: RerankItem[]): Promise<RerankResult[]>
}

// 精排是准确率从"能用"到"可信"的分界,但它绝不能成为可用性的单点。
// 超过这个预算就放弃精排,用 RRF 顺序返回 —— 慢答案比无答案好,
// 而无精排的答案仍然可用(只是排序略差)。
export const RERANK_TIMEOUT_MS = 300

class RemoteReranker implements Reranker {
  readonly crossEncoder = true
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
  const q = new Set(questionGrams(query))
  if (q.size === 0) return 0
  const t = new Set(gram2(text))
  let hit = 0
  for (const g of q) if (t.has(g)) hit++
  return hit / q.size
}

// 这些词描述“怎么问”，不是“问什么”。若把它们计入覆盖率，
// “报销需要几级审批”即使命中“报销审批”也只有很低分；反过来，
// “月球基地的班车安排”又会因“安排”偶然命中。只在 query 侧移除，
// 文档侧仍保留完整文本供证据匹配。
const QUESTION_NOISE = [
  '最少几位', '是多少', '是怎样的', '是什么时候',
  '是哪个部门', '有哪些', '怎么处理', '提前多久', '多少金额',
  '才能开始', '能不能', '到几点', '年龄分组', '一次几本',
  '多久一次', '怎么办', '如何', '怎样', '怎么', '哪些', '什么',
  '多少', '多久', '几天', '几级', '几位', '多长', '由谁', '谁来',
  '何处', '哪里', '能否', '是否', '可以', '需要', '一共', '请问',
  '关于', '公司', '一下', '是哪天', '类型', '比例', '流程', '政策',
  '规则', '安排'
]

function questionGrams(value: string): string[] {
  let normalized = value
    .toLowerCase()
    .replaceAll('薪资', '薪酬')
    .replaceAll('股票激励', '持股')
    .replaceAll('上限', '限额')
  for (const noise of QUESTION_NOISE) normalized = normalized.replaceAll(noise, '')
  const cleaned = gram2(normalized)
  return cleaned.length > 0 ? cleaned : gram2(value)
}

function gram2(s: string): string[] {
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const out: string[] = []
  for (let i = 0; i < norm.length - 1; i++) out.push(norm.slice(i, i + 2))
  return out
}

class LexicalReranker implements Reranker {
  readonly model = 'lexical-dev'
  readonly crossEncoder = false
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
