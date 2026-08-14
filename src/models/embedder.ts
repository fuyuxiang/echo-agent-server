import type { Config } from '../config.js'

export interface Embedder {
  readonly model: string
  readonly dim: number
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

/**
 * 确定性伪嵌入。
 *
 * 存在的意义是让测试与本地开发不依赖模型文件或外部 API。它有真实的
 * 语义能力吗?没有 —— 相同文本给相同向量,仅此而已。所以:
 *   · 生产必须配 ECHO_EMBED_URL 或本地 ONNX 模型;
 *   · 评估集跑分时若发现向量路召回全为 0,先确认不是落到了这个实现上。
 * 启动时会打 warning,不让它悄悄成为生产配置。
 */
export function hashEmbed(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0)
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
  for (const tok of tokens) {
    let h = 2166136261
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    for (let i = 0; i < 8; i++) {
      h = Math.imul(h, 16777619) ^ i
      vec[Math.abs(h) % dim] += ((h >>> 8) % 256 - 128) / 128
    }
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
  return vec.map((x) => x / norm)
}

class HashEmbedder implements Embedder {
  readonly model = 'hash-dev'
  constructor(readonly dim: number) {}
  async embed(text: string): Promise<number[]> {
    return hashEmbed(text, this.dim)
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dim))
  }
}

class RemoteEmbedder implements Embedder {
  constructor(
    readonly model: string,
    readonly dim: number,
    private url: string,
    private key?: string
  ) {}

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text])
    return v
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.key ? { authorization: `Bearer ${this.key}` } : {})
      },
      body: JSON.stringify({ model: this.model, input: texts })
    })
    if (!res.ok) {
      throw new Error(`embedding API ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] }
    const vecs = json.data.map((d) => d.embedding)
    for (const v of vecs) {
      // 维度不符会让 vec0 写入静默失败或检索结果错乱,必须早失败。
      if (v.length !== this.dim) {
        throw new Error(
          `嵌入维度不符: 期望 ${this.dim}, 实得 ${v.length}。` +
            `请对齐 ECHO_EMBED_DIM 与 ECHO_EMBED_MODEL`
        )
      }
    }
    return vecs
  }
}

export function createEmbedder(cfg: Config, warn?: (m: string) => void): Embedder {
  if (cfg.embedUrl) {
    return new RemoteEmbedder(cfg.embedModel, cfg.embedDim, cfg.embedUrl, cfg.embedKey)
  }
  warn?.(
    '未配置 ECHO_EMBED_URL,回退到 hash 伪嵌入 —— 仅供开发/测试,向量检索无真实语义能力'
  )
  return new HashEmbedder(cfg.embedDim)
}
