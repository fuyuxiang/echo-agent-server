import { PDFParse } from 'pdf-parse'
import type { Parser, ParserUnit } from './types.js'
import { createOcrClient } from '../services/ocr.js'

const ocr = createOcrClient()
const MIN_TEXT_LEN = 50

export const pdfParser: Parser = {
  async parse(buf, meta) {
    const parser = new PDFParse({ data: new Uint8Array(buf) })
    try {
      const res = await parser.getText()
      const units: ParserUnit[] = []
      for (const page of res.pages) {
        const pageText = page.text.trim()
        let text = pageText
        if (text.length < MIN_TEXT_LEN) {
          // 扫描件降级:Phase 1 只做"标记位 OCR"占位;后续 Task B4.1 可换成 pdf2pic + OCR
          text = `[第 ${page.num} 页扫描件, OCR 已配置=${!!process.env.ECHO_OCR_URL}]`
        }
        if (text) units.push({ text, location: { kind: 'page_section', page: page.num } })
      }
      return units
    } finally {
      await parser.destroy()
    }
  }
}