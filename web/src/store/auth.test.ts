import { beforeEach, describe, expect, it } from 'vitest'
import { saveAuth, loadAuth, clearAuth, getToken } from './auth'
import type { AuthState } from '../types'

const sample: AuthState = {
  token: 'tok123',
  user: { id: 'u1', username: 'admin', role: 'admin', groupId: null },
}

describe('auth store', () => {
  beforeEach(() => localStorage.clear())

  it('saves and loads auth state', () => {
    saveAuth(sample)
    expect(loadAuth()).toEqual(sample)
    expect(getToken()).toBe('tok123')
  })

  it('returns null when empty', () => {
    expect(loadAuth()).toBeNull()
    expect(getToken()).toBeNull()
  })

  it('clears auth state', () => {
    saveAuth(sample)
    clearAuth()
    expect(loadAuth()).toBeNull()
  })
})
