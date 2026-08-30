import { describe, expect, it, beforeEach } from 'vitest'
import {
  saveAuth, loadAuth, clearAuth, getToken, getRefreshToken, getUser,
  updateTokens, isAdmin, canReview,
} from './auth'
import type { AuthState, Role } from '../types'

function sample(role: Role = 'admin'): AuthState {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    user: {
      id: 'u1',
      username: 'admin',
      displayName: '管理员',
      role,
      clearance: 2,
      groups: [{ id: 'g1', name: '技术部' }],
      scopes: ['s_org', 's_tech'],
    },
  }
}

beforeEach(() => clearAuth())

describe('auth store', () => {
  it('saves and loads auth state', () => {
    saveAuth(sample())
    expect(loadAuth()).toEqual({ ...sample(), refreshToken: '' })
    expect(getToken()).toBe('access-1')
    expect(getRefreshToken()).toBeNull()
    expect(getUser()?.displayName).toBe('管理员')
  })

  it('returns null when nothing is stored', () => {
    expect(loadAuth()).toBeNull()
    expect(getToken()).toBeNull()
    expect(getUser()).toBeNull()
  })

  it('clears state', () => {
    saveAuth(sample())
    clearAuth()
    expect(loadAuth()).toBeNull()
  })

  // 脏数据当作未登录,而不是让整个应用在 JSON.parse 处崩掉。
  it('treats corrupt storage as logged out', () => {
    localStorage.setItem('echo-admin-auth', '{not json')
    expect(loadAuth()).toBeNull()
    expect(getToken()).toBeNull()
  })

  it('replaces only the tokens on refresh', () => {
    saveAuth(sample())
    updateTokens('access-2', 'refresh-2')
    expect(getToken()).toBe('access-2')
    expect(getRefreshToken()).toBeNull()
    // 刷新不该丢掉会话里的用户信息
    expect(getUser()?.displayName).toBe('管理员')
    expect(getUser()?.scopes).toEqual(['s_org', 's_tech'])
  })

  it('ignores a token update when not logged in', () => {
    updateTokens('a', 'r')
    expect(loadAuth()).toBeNull()
  })

  it('reports roles for menu gating', () => {
    saveAuth(sample('admin'))
    expect(isAdmin()).toBe(true)
    expect(canReview()).toBe(true)

    saveAuth(sample('curator'))
    expect(isAdmin()).toBe(false)
    expect(canReview()).toBe(true)

    saveAuth(sample('member'))
    expect(isAdmin()).toBe(false)
    expect(canReview()).toBe(false)
  })
})
