export interface OcrClient {
  extractFromImage(buf: Buffer): Promise<string>
}

export function createOcrClient(): OcrClient {
  const url = process.env.ECHO_OCR_URL
  if (!url) {
    return { extractFromImage: async (b) => `[OCR未配置:${b.length}B]` }
  }
  return {
    async extractFromImage(buf: Buffer): Promise<string> {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)]), 'page.png')
      const res = await fetch(url, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`ocr API ${res.status}`)
      const j = await res.json() as { text: string }
      return j.text
    }
  }
}