import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { docxParser } from '../../src/kb/parsers/docx.js'

describe('docxParser', () => {
  it('extracts paragraphs and headings as units with section location', async () => {
    // 测试样本: test/fixtures/sample.docx (手工放一个最小 docx,只含"标题一"+"段落"+"标题二"+"段落")
    const buf = readFileSync(join(__dirname, '../fixtures/sample.docx'))
    const units = await docxParser.parse(buf, { docId: 'd1', fileName: 'sample.docx' })
    expect(units.length).toBeGreaterThanOrEqual(2)
    const headings = units.filter(u => (u.location as any).section?.startsWith('heading'))
    expect(headings.length).toBeGreaterThanOrEqual(1)
  })
})
