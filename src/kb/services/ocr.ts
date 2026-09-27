import type { Config } from '../../config.js'
import type { VlmClient } from './vlm.js'

const OCR_PROMPT = '请逐字识别这张文档页面上的文字和表格，按阅读顺序只输出识别出的纯文本。保留标题、数字、单位和表格行列关系；不要总结或补充看不清的内容。如果页面没有可识别的文字，只输出【无可识别文字】。'

export interface OcrClient {
  /** 是否已配置远端服务。用于 health 端点与诊断。 */
  readonly configured: boolean
  extractFromImage(buf: Buffer): Promise<string>
}

/**
 * OCR 客户端。
 *
 * 优先使用独立 OCR 接口；未配置时复用 M3 图片理解客户端。
 * PDF 解析器会先看 configured，并由后置校验把空扫描件标为 failed。
 *
 * cfg 可选:不传时回退到 env(兼容 parsers 在模块加载时调用);
 * 注入路径(app.ts)必须传 cfg,让 Deps 与 health 暴露与真实配置一致。
 */
export function createOcrClient(cfg?: Config, warn?: (m: string) => void, vlm?: VlmClient): OcrClient {
  const url = cfg?.ocrUrl ?? process.env.ECHO_OCR_URL
  const key = cfg?.ocrKey ?? process.env.ECHO_OCR_KEY
  if (!url && vlm?.configured) {
    return {
      configured: true,
      async extractFromImage(buf): Promise<string> {
        const text = (await vlm.caption(buf, 'image/png', OCR_PROMPT, 4096)).trim()
        if (/^(?:【无可识别文字】|\[NO_TEXT\]|没有(?:发现|看到|可识别|清晰可读).*文字|我没有看到您上传的文档图像)/.test(text)) return ''
        return text
      }
    }
  }
  if (!url) {
    warn?.('未配置 OCR 远端，扫描 PDF 将明确摄取失败')
    return {
      configured: false,
      extractFromImage: async () => { throw new Error('OCR 服务未配置') }
    }
  }
  return {
    configured: true,
    extractFromImage: async (buf: Buffer): Promise<string> => {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)]), 'page.png')
      const res = await fetch(url, {
        method: 'POST',
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: form
      })
      if (!res.ok) throw new Error(`ocr API ${res.status}`)
      const j = (await res.json()) as { text: string }
      return j.text
    }
  }
}
