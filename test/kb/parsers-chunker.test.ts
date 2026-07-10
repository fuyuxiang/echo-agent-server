import { describe, it, expect } from 'vitest'
import { semanticChunk } from '../../src/kb/parsers/chunker.js'
import type { Location } from '../../src/kb/types.js'

const loc = (i: number): Location => ({ kind: 'plain', offset: i, length: 0 })

describe('semanticChunk', () => {
  it('keeps short unit as a single chunk', () => {
    const out = semanticChunk([{ text: 'hello world', location: loc(0) }])
    expect(out).toEqual([{ text: 'hello world', location: loc(0) }])
  })

  it('splits a long paragraph into overlapping chunks', () => {
    const long = '段一。' + '句子'.repeat(200) + '。段二。' + '句子'.repeat(200) + '。'
    const out = semanticChunk([{ text: long, location: loc(0) }], { maxChars: 400, overlapChars: 50 })
    expect(out.length).toBeGreaterThanOrEqual(2)
    // The second chunk should include the last 50 chars from the first chunk.
    const tail = out[0].text.slice(-50)
    expect(out[1].text.startsWith(tail)).toBe(true)
  })

  it('preserves location kind on every produced chunk', () => {
    const out = semanticChunk([{ text: 'a'.repeat(2000), location: { kind: 'page_section', page: 3 } }])
    expect(out.length).toBeGreaterThan(1)
    for (const u of out) expect(u.location.kind).toBe('page_section')
  })
})
