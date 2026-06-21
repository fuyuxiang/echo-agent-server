import { describe, it, expect } from 'vitest'
import { hashEmbedding } from '../src/embedding.js'

describe('hashEmbedding', () => {
  it('is deterministic and correct length', () => {
    const a = hashEmbedding('hello', 1024)
    const b = hashEmbedding('hello', 1024)
    expect(a).toHaveLength(1024)
    expect(a).toEqual(b)
  })
  it('differs for different text', () => {
    expect(hashEmbedding('a')).not.toEqual(hashEmbedding('b'))
  })
})
