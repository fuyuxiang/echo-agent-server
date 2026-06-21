import { describe, it, expect } from 'vitest'
import { ok, fail } from '../src/reply.js'

describe('reply envelope', () => {
  it('ok wraps data with code 0', () => {
    expect(ok({ a: 1 })).toEqual({ code: 0, msg: 'ok', data: { a: 1 } })
  })
  it('fail carries code and msg, null data', () => {
    expect(fail(1001, 'bad')).toEqual({ code: 1001, msg: 'bad', data: null })
  })
})
