import type { Config } from '../config.js'

export interface Embedder {
  readonly model: string
  readonly dim: number
  /**
   * 是否具备真实语义能力。
   *
   * 占位实现能让链路跑通,但"住宿标准"查不到"住宿费用上限" —— 而配置里
   * 写的仍是 bge-m3,管理员从模型名看不出差别。启动 warning 会滚出屏幕,
   * 所以要能在运行时查到这个标记。
   */
  readonly semantic: boolean
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
  readonly semantic = false
  constructor(readonly dim: number) {}
  async embed(text: string): Promise<number[]> {
    return hashEmbed(text, this.dim)
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dim))
  }
}

class RemoteEmbedder implements Embedder {
  readonly semantic = true
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

    // 限流与瞬时故障要重试:摄取阶段一批 32 个 chunk,一次 429 就让这批
    // 向量全部缺失,而文档仍会被标为 ready —— 表现是"文档看着正常但语义
    // 检索永远查不到它"。
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 500 * 4 ** (attempt - 1)))
      }
      try {
        return await this.callOnce(texts)
      } catch (e) {
        lastErr = e as Error
        // 维度不符是配置错误,重试无意义且会拖慢失败反馈
        if (lastErr.message.includes('维度不符')) throw lastErr
      }
    }
    throw lastErr ?? new Error('embedding 调用失败')
  }

  private async callOnce(texts: string[]): Promise<number[][]> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.key ? { authorization: `Bearer ${this.key}` } : {})
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) {
      throw new Error(`embedding API ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] }
    if (!Array.isArray(json.data)) {
      throw new Error('embedding API 响应格式异常:缺少 data 数组')
    }
    const vecs = json.data.map((d) => d.embedding)
    if (vecs.length !== texts.length) {
      // 数量不符会让 chunk 与向量错位,后果是检索命中张冠李戴的内容
      throw new Error(`embedding 数量不符: 请求 ${texts.length}, 返回 ${vecs.length}`)
    }
    for (const v of vecs) {
      // 维度不符会让 vec0 写入静默失败或检索结果错乱,必须早失败。
      if (!Array.isArray(v) || v.length !== this.dim) {
        throw new Error(
          `嵌入维度不符: 期望 ${this.dim}, 实得 ${v?.length ?? 0}。` +
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
