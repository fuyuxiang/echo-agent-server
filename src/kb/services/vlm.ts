/**
 * VLM caption 客户端。
 *
 * 图片/图表/PPT 页的"看图说话"能力 —— 用多模态模型生成 200 字内中文描述,
 * 落 modality='caption' chunk,作为可检索的语义索引。
 *
 * 走 cfg.vlmUrl + cfg.vlmKey 启用；缺位时明确抛错，上传入口也会同步拒绝。
 *
 * cfg 可选:不传时回退到 env(兼容 parsers 在模块加载时调用);
 * 注入路径(app.ts)必须传 cfg,让 Deps 与 health 暴露与真实配置一致。
 */

import type { Config } from '../../config.js'

export interface VlmClient {
  /** 是否已配置远端服务。用于 health 端点与诊断。 */
  readonly configured: boolean
  readonly model: string | null
  caption(buf: Buffer, mime: string): Promise<string>
}

export function createVlmClient(
  cfg?: Config,
  warn?: (m: string) => void
): VlmClient {
  const url = cfg?.vlmUrl ?? process.env.ECHO_VLM_URL
  const key = cfg?.vlmKey ?? process.env.ECHO_VLM_KEY
  const model = cfg?.vlmModel ?? process.env.ECHO_VLM_MODEL
  if (!url) {
    warn?.('未配置 VLM 远端，图片上传将被拒绝')
    return {
      configured: false,
      model: model ?? null,
      caption: async () => { throw new Error('VLM 服务未配置') }
    }
  }
  return {
    configured: true,
    model: model ?? null,
    async caption(buf: Buffer, mime: string): Promise<string> {
      const form = new FormData()
      form.append('image', new Blob([new Uint8Array(buf)], { type: mime }), `image.${mime.split('/')[1] ?? 'png'}`)
      form.append('max_tokens', '300')
      form.append('lang', 'zh')
      if (model) form.append('model', model)
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
