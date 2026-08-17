import { PDFParse } from 'pdf-parse'
import type { Parser, ParserUnit } from './types.js'
import { createOcrClient } from '../services/ocr.js'

const ocr = createOcrClient()
const MIN_TEXT_LEN = 50

export const pdfParser: Parser = {
  sourceType: 'pdf',
  async parse(buf, meta) {
    const parser = new PDFParse({ data: new Uint8Array(buf) })
    try {
      const res = await parser.getText()
      const units: ParserUnit[] = []
      for (const page of res.pages) {
        const pageText = page.text.trim()
        let text = pageText
        if (text.length < MIN_TEXT_LEN) {
          // 扫描件降级:真实调 OCR 抽取图片层文本。
          // 解析失败或未配置 OCR 时返回空字符串,后置校验会把它标 failed。
          try {
            text = await ocr.extractFromImage(buf)
            if (text.length < MIN_TEXT_LEN) text = ''
          } catch {
            text = ''
          }
        }
        if (text) units.push({ text, location: { kind: 'page_section', page: page.num } })
      }
      return units
    } finally {
      await parser.destroy()
    }
  }
}
