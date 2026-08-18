import type { Config } from '../../config.js'

export interface OcrClient {
  /** 是否已配置远端服务。用于 health 端点与诊断。 */
  readonly configured: boolean
  extractFromImage(buf: Buffer): Promise<string>
}

/**
 * OCR 客户端。
 *
 * 走 cfg.ocrUrl:true 表示已配置,缺位时返回占位实现,避免静默产出空索引 —
 * 后置校验会把没有真实文本的文档标为 failed,而不是悄悄让它 ready。
 *
 * cfg 可选:不传时回退到 env(兼容 parsers 在模块加载时调用);
 * 注入路径(app.ts)必须传 cfg,让 Deps 与 health 暴露与真实配置一致。
 */
export function createOcrClient(cfg?: Config, warn?: (m: string) => void): OcrClient {
  const url = cfg?.ocrUrl ?? process.env.ECHO_OCR_URL
  if (!url) {
    warn?.('未配置 OCR 远端,扫描件将落到占位实现 —— 仅供开发/测试')
    return {
      configured: false,
      extractFromImage: async (b: Buffer) => `[OCR未配置:${b.length}B]`
    }
  }
  return {
    configured: true,
    extractFromImage: async (buf: Buffer): Promise<string> => {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)]), 'page.png')
      const res = await fetch(url, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`ocr API ${res.status}`)
      const j = (await res.json()) as { text: string }
      return j.text
    }
  }
}
