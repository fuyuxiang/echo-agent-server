import { PDFParse } from 'pdf-parse'
import type { Parser, ParserUnit } from './types.js'
import { createOcrClient, type OcrClient } from '../services/ocr.js'
const MIN_TEXT_LEN = 50

export function createPdfParser(ocr: OcrClient): Parser {
  return {
    sourceType: 'pdf',
    async parse(buf) {
      const parser = new PDFParse({ data: new Uint8Array(buf) })
      try {
        const res = await parser.getText()
        const units: ParserUnit[] = []
        for (const page of res.pages) {
          const pageText = page.text.trim()
          let text = pageText
          if (text.length < MIN_TEXT_LEN && ocr.configured) {
            try {
              const screenshot = await parser.getScreenshot({
                partial: [page.num],
                desiredWidth: 1800
              })
              const png = screenshot.pages[0]?.data
              text = png ? await ocr.extractFromImage(Buffer.from(png)) : ''
              if (text.length < MIN_TEXT_LEN) text = ''
            } catch {
              text = ''
            }
          } else if (text.length < MIN_TEXT_LEN) {
            text = ''
          }
          if (text) units.push({ text, location: { kind: 'page_section', page: page.num } })
        }
        return units
      } finally {
        await parser.destroy()
      }
    }
  }
}

/** 兼容直接使用 Parser 的测试；生产摄取通过 parseDocument 注入 Client。 */
export const pdfParser: Parser = createPdfParser(createOcrClient())
