import { createHash } from 'node:crypto'

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

export function hashEmbedding(text: string, dim = 1024): number[] {
  const vec = new Array<number>(dim).fill(0)
  // spread tokens across dimensions via rolling hash for a deterministic pseudo-vector
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
  for (const tok of tokens) {
    const h = createHash('md5').update(tok).digest()
    for (let i = 0; i < h.length; i++) {
      vec[(h[i] + i * 31) % dim] += (h[i] - 128) / 128
    }
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
  return vec.map((x) => x / norm)
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const url = process.env.ECHO_EMBED_URL
  const k = process.env.ECHO_EMBED_KEY
  const model = process.env.ECHO_EMBED_MODEL ?? 'text-embedding-3-small'
  if (!url || !k) {
    return { embed: async (t) => hashEmbedding(t) }
  }
  return {
    async embed(text: string): Promise<number[]> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
        body: JSON.stringify({ model, input: text })
      })
      if (!res.ok) throw new Error(`embedding API error ${res.status}: ${await res.text()}`)
      const json = (await res.json()) as { data: { embedding: number[] }[] }
      const vec = json.data[0].embedding
      if (vec.length !== 1024) throw new Error(`embedding dim mismatch: expected 1024, got ${vec.length}. Set ECHO_EMBED_MODEL to a 1024-dim model or configure dimensions parameter`)
      return vec
    }
  }
}
