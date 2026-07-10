import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pdfParser } from '../../src/kb/parsers/pdf.js'

vi.mock('../../src/kb/services/ocr.js', () => ({
  createOcrClient: () => ({
    extractFromImage: vi.fn(async () => 'OCR 结果文本'),
  }),
}))

describe('pdfParser', () => {
  it('extracts text per page with page_section location', async () => {
    // 测试样本: test/fixtures/sample.pdf (含 2 页文本)
    const buf = readFileSync(join(__dirname, '../fixtures/sample.pdf'))
    const units = await pdfParser.parse(buf, { docId: 'd1', fileName: 'sample.pdf' })
    expect(units.length).toBeGreaterThanOrEqual(1)
    expect(units[0].location.kind).toBe('page_section')
    expect((units[0].location as any).page).toBeGreaterThanOrEqual(1)
  })
})