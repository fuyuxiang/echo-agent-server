/**
 * 图片解析器。
 *
 * 调用 VLM caption 通道，产出带页定位的单个可检索单元。
 */

import { createVlmClient, type VlmClient } from '../services/vlm.js'
import type { Parser, ParserUnit } from './types.js'

let _client: VlmClient | null = null
function client(): VlmClient {
  if (!_client) {
    // parser 处于模块加载期,此时 cfg 尚未注入;走 env 回退。
    _client = createVlmClient()
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

/** parseDocument 未显式注入时使用环境变量构造的 VLM 客户端。 */
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

/** 生产注入入口，确保 health 展示与实际摄取使用同一个 VLM 实例。 */
export function createImageCaptionParser(vlm: VlmClient): Parser {
  return {
    sourceType: 'image',
    async parse(buf: Buffer, ctx?: { fileName?: string }): Promise<ParserUnit[]> {
      if (!vlm.configured) return []
      const mime = mimeFromName(ctx?.fileName ?? 'image.png')
      const caption = (await vlm.caption(buf, mime)).trim()
      if (!caption || /^\[(?:VLM|图片).*未配置/.test(caption)) return []
      return [
        {
          text: caption,
          location: { kind: 'page_section', page: 1, section: 'image-caption' }
        }
      ]
    }
  }
}
