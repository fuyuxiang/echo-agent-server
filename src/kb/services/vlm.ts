/**
 * VLM caption 客户端。
 *
 * 图片/图表/PPT 页的"看图说话"能力 —— 用多模态模型生成 200 字内中文描述,
 * 落 modality='caption' chunk,作为可检索的语义索引。
 *
 * 配置 ECHO_VLM_URL / ECHO_VLM_KEY 启用;否则返回占位 caption,
 * 标注"未配置",避免静默产出空索引。
 */

export interface VlmClient {
  caption(buf: Buffer, mime: string): Promise<string>
}

export function createVlmClient(opts: { url?: string; key?: string }): VlmClient {
  const { url, key } = opts
  if (!url) {
    return {
      caption: async (b) => `[VLM未配置:${b.length}B]`
    }
  }
  return {
    async caption(buf: Buffer, mime: string): Promise<string> {
      const form = new FormData()
      form.append('image', new Blob([new Uint8Array(buf)], { type: mime }), `image.${mime.split('/')[1] ?? 'png'}`)
      form.append('max_tokens', '300')
      form.append('lang', 'zh')
      const res = await fetch(url, {
        method: 'POST',
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: form
      })
      if (!res.ok) throw new Error(`vlm API ${res.status}`)
      const j = (await res.json()) as { caption?: string; text?: string }
      const text = (j.caption ?? j.text ?? '').trim()
      if (!text) throw new Error('vlm returned empty caption')
      return text
    }
  }
}
