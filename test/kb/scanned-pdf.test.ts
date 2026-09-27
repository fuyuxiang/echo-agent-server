import { describe, expect, it, vi } from 'vitest'

vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() { return { pages: [{ num: 1, text: '' }] } }
    async getScreenshot() { return { pages: [{ data: Buffer.from('png-page') }] } }
    async destroy() {}
  }
}))

import { createPdfParser } from '../../src/kb/parsers/pdf.js'

describe('扫描版 PDF', () => {
  it('把页面截图交给 OCR，并保留短文本与页码', async () => {
    const extractFromImage = vi.fn(async () => '短标题')
    const parser = createPdfParser({ configured: true, extractFromImage })
    const units = await parser.parse(Buffer.from('pdf'), { docId: 'scan', fileName: 'scan.pdf' })
    expect(extractFromImage).toHaveBeenCalledWith(Buffer.from('png-page'))
    expect(units).toEqual([{ text: '短标题', location: { kind: 'page_section', page: 1 } }])
  })
})
