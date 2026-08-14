import type { Candidate } from './recall.js'

/**
 * Reciprocal Rank Fusion.
 *
 *   score(d) = Σ_i 1 / (k + rank_i(d))
 *
 * 只用名次不用分数,这是刻意的:BM25 分数与向量距离量纲完全不同,
 * 归一化加权求和对分数分布极敏感 —— 换个嵌入模型就得重调权重。
 * RRF 无参可调(k 除外)、对异常分数免疫,是多路融合的稳妥默认。
 *
 * k=60 是文献常用值:越大越平均各路贡献,越小越偏向头部名次。
 */
export const RRF_K = 60

export interface FusedCandidate extends Candidate {
  fusedScore: number
  /** 命中了哪几路。两路都命中通常是强信号。 */
  sources: string[]
}

export function fuseRRF(
  lists: { name: string; items: Candidate[] }[],
  k = RRF_K
): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate>()

  for (const { name, items } of lists) {
    for (const item of items) {
      const existing = byId.get(item.chunkId)
      const contribution = 1 / (k + item.rank)

      if (existing) {
        existing.fusedScore += contribution
        existing.sources.push(name)
        // 保留更靠前的名次,便于诊断
        if (item.rank < existing.rank) existing.rank = item.rank
      } else {
        byId.set(item.chunkId, {
          ...item,
          fusedScore: contribution,
          sources: [name]
        })
      }
    }
  }

  return [...byId.values()].sort((a, b) => b.fusedScore - a.fusedScore)
}

/** 同一文档的 chunk 过多会挤掉其他文档,损害答案的视野广度。 */
export function capPerDocument<T extends { docId: string }>(
  items: T[],
  maxPerDoc: number
): T[] {
  const counts = new Map<string, number>()
  const out: T[] = []
  for (const item of items) {
    const n = counts.get(item.docId) ?? 0
    if (n >= maxPerDoc) continue
    counts.set(item.docId, n + 1)
    out.push(item)
  }
  return out
}
