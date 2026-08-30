import type { Config } from '../../config.js'

export interface OcrClient {
  /** 是否已配置远端服务。用于 health 端点与诊断。 */
  readonly configured: boolean
  extractFromImage(buf: Buffer): Promise<string>
}

/**
 * OCR 客户端。
 *
 * 走 cfg.ocrUrl:true 表示已配置；缺位时明确抛错。生产 PDF 解析器会先看
 * configured，并由后置校验把没有真实文本的扫描件标为 failed。
 *
 * cfg 可选:不传时回退到 env(兼容 parsers 在模块加载时调用);
 * 注入路径(app.ts)必须传 cfg,让 Deps 与 health 暴露与真实配置一致。
 */
export function createOcrClient(cfg?: Config, warn?: (m: string) => void): OcrClient {
  const url = cfg?.ocrUrl ?? process.env.ECHO_OCR_URL
  const key = cfg?.ocrKey ?? process.env.ECHO_OCR_KEY
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
