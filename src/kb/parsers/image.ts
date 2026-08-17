/**
 * 图片解析器。
 *
 * 默认调用 VLM caption 通道,产出 modality='caption' 的单个 chunk;
 * 若 VLM 未配置,显式输出"未配置"占位,让后置校验把它标 failed,
 * 避免静默产生空 chunk。
 */

import { createVlmClient, type VlmClient } from '../services/vlm.js'
import type { Parser, ParserUnit } from './types.js'

let _client: VlmClient | null = null
function client(): VlmClient {
  if (!_client) {
    const url = process.env.ECHO_VLM_URL
    const key = process.env.ECHO_VLM_KEY
    _client = createVlmClient({ url, key })
  }
  return _client
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp'
    }[ext] ?? 'application/octet-stream'
  )
}

export const imageParser: Parser = {
  sourceType: 'image',
  async parse(buf: Buffer, ctx?: { fileName?: string }): Promise<ParserUnit[]> {
    void client() // 占位:目前未用到但保持引用以便后续接入
    const text = `[图片:${ctx?.fileName ?? 'untitled'},${buf.length}B;尚未配置 VLM 描述]`
    return [
      {
        text,
        location: { kind: 'page_section', page: 1, section: 'image-caption' }
      }
    ]
  }
}

/**
 * 真正调用 VLM 生成 caption 的入口。
 * parseDocument 在 image 类型时优先使用本解析器,产出 caption chunk。
 */
export const imageCaptionParser: Parser = {
  sourceType: 'image',
  async parse(buf: Buffer, ctx?: { fileName?: string }): Promise<ParserUnit[]> {
    const mime = mimeFromName(ctx?.fileName ?? 'image.png')
    const caption = await client().caption(buf, mime)
    return [
      {
        text: caption,
        location: { kind: 'page_section', page: 1, section: 'image-caption' }
      }
    ]
  }
}
