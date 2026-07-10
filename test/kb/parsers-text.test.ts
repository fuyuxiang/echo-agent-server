import { describe, it, expect } from 'vitest'
import { textParser } from '../../src/kb/parsers/text.js'

describe('textParser', () => {
  it('splits by blank lines into plain-located units', async () => {
    const units = await textParser.parse(Buffer.from('第一段。\n\n第二段。\n\n第三段。'), {
      docId: 'd1', fileName: 'a.txt'
    })
    expect(units.map(u => u.text)).toEqual(['第一段。', '第二段。', '第三段。'])
    expect(units[0].location).toEqual({ kind: 'plain', offset: 0, length: 4 })
  })
})