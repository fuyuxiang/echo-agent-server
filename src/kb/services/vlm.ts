/**
 * VLM caption 客户端。
 *
 * 图片/图表/PPT 页的"看图说话"能力 —— 用多模态模型生成 200 字内中文描述,
 * 落 modality='caption' chunk,作为可检索的语义索引。
 *
 * 优先使用独立 caption 接口；未配置时复用已配置的 MiniMax-M3 聊天接口。
 *
 * cfg 可选:不传时回退到 env(兼容 parsers 在模块加载时调用);
 * 注入路径(app.ts)必须传 cfg,让 Deps 与 health 暴露与真实配置一致。
 */

import type { Config } from '../../config.js'
import type { EffectiveChatConfig } from '../../models/chat-config.js'
import { spawn } from 'node:child_process'

const CAPTION_PROMPT = '请用中文客观描述图片中的可见内容，并准确抄录清晰可读的文字。不要猜测看不清的内容。'

function responseText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim()
  if (Array.isArray(value)) return value.map((part) =>
    typeof part === 'object' && part !== null && 'text' in part ? responseText(part.text) : ''
  ).join('\n').trim()
  return ''
}

async function imageForChat(buf: Buffer, mime: string): Promise<{ bytes: Buffer; mime: string }> {
  if ((mime === 'image/png' || mime === 'image/jpeg') && buf.length <= 8 * 1024 * 1024) {
    return { bytes: buf, mime }
  }
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', 'scale=1600:1600:force_original_aspect_ratio=decrease,format=yuvj420p',
      '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    const parts: Buffer[] = []
    let size = 0
    let stderr = ''
    child.stdout.on('data', (part: Buffer) => {
      size += part.length
      if (size > 8 * 1024 * 1024) child.kill()
      else parts.push(part)
    })
    child.stderr.on('data', (part: Buffer) => { stderr += part.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (size > 8 * 1024 * 1024) reject(new Error('图片转换后仍超过 8MB'))
      else if (code !== 0 || size === 0) reject(new Error(`图片转换失败: ${stderr.slice(-200)}`))
      else resolve({ bytes: Buffer.concat(parts), mime: 'image/jpeg' })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(buf)
  })
}

export interface VlmClient {
  /** 是否已配置远端服务。用于 health 端点与诊断。 */
  readonly configured: boolean
  readonly model: string | null
  caption(buf: Buffer, mime: string, prompt?: string, maxTokens?: number): Promise<string>
}

export function createVlmClient(
  cfg?: Config,
  warn?: (m: string) => void,
  chat?: EffectiveChatConfig
): VlmClient {
  const url = cfg?.vlmUrl ?? process.env.ECHO_VLM_URL
  const key = cfg?.vlmKey ?? process.env.ECHO_VLM_KEY
  const model = cfg?.vlmModel ?? process.env.ECHO_VLM_MODEL
  if (!url && chat?.configured && chat.key && chat.model && /minimax-m3/i.test(chat.model)) {
    return {
      configured: true,
      model: chat.model,
      async caption(buf: Buffer, mime: string, prompt = CAPTION_PROMPT, maxTokens = 1200): Promise<string> {
        const image = await imageForChat(buf, mime)
        const res = await fetch(`${chat.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${chat.key}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: chat.model,
            stream: false,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.bytes.toString('base64')}` } }
            ] }]
          }),
          signal: AbortSignal.timeout(90_000)
        })
        if (!res.ok) throw new Error(`M3 图片理解 API ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const data = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> }
        const text = responseText(data.choices?.[0]?.message?.content)
        if (!text) throw new Error('M3 图片理解返回空文本')
        return text
      }
    }
  }
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
    async caption(buf: Buffer, mime: string, _prompt?: string): Promise<string> {
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
