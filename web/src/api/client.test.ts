import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import client from './client'
import { saveAuth, clearAuth, loadAuth } from '../store/auth'
import type { AuthState } from '../types'

const mock = new MockAdapter(client)
// refresh 走裸 axios(避免拦截器递归),所以要单独挂一个 adapter。
const bare = new MockAdapter(axios)

const AUTH: AuthState = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: {
    id: 'u1',
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    clearance: 2,
    groups: [],
    scopes: ['s_org'],
  },
}

beforeEach(() => {
  mock.reset()
  bare.reset()
  clearAuth()
  vi.stubGlobal('location', { pathname: '/documents', assign: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api client', () => {
  it('unwraps data when code===0', async () => {
    mock.onGet('/api/v1/ping').reply(200, { code: 0, msg: 'ok', data: { pong: true } })
    expect(await client.get('/api/v1/ping')).toEqual({ pong: true })
  })

  it('rejects with the server message when code!==0', async () => {
    mock.onGet('/api/v1/ping').reply(200, { code: 4091, msg: '用户名已存在', data: null })
    await expect(client.get('/api/v1/ping')).rejects.toThrow('用户名已存在')
  })

  it('injects Authorization header when logged in', async () => {
    saveAuth(AUTH)
    mock.onGet('/api/v1/ping').reply((cfg) => {
      expect(cfg.headers?.Authorization).toBe('Bearer access-1')
      return [200, { code: 0, msg: 'ok', data: 1 }]
    })
    await client.get('/api/v1/ping')
  })

  // access token 只有 1 小时。不静默刷新的话,管理员填一半表单就会被踢回登录页。
  it('refreshes once on 401 and retries the request', async () => {
    saveAuth(AUTH)
    bare.onPost('/api/v1/auth/refresh').reply(200, {
      code: 0,
      msg: 'ok',
      data: { accessToken: 'access-2', refreshToken: 'refresh-2' },
    })

    let calls = 0
    mock.onGet('/api/v1/docs').reply(() => {
      calls++
      // 首次拿旧 token 返回 401,重试时应带上刷新后的新 token。
      return calls === 1 ? [401] : [200, { code: 0, msg: 'ok', data: { items: [] } }]
    })

    expect(await client.get('/api/v1/docs')).toEqual({ items: [] })
    expect(calls).toBe(2)
    expect(loadAuth()?.accessToken).toBe('access-2')
  })

  it('keeps the session user when only tokens are refreshed', async () => {
    saveAuth(AUTH)
    bare.onPost('/api/v1/auth/refresh').reply(200, {
      code: 0,
      msg: 'ok',
      data: { accessToken: 'access-2', refreshToken: 'refresh-2' },
    })
    let calls = 0
    mock.onGet('/api/v1/docs').reply(() => {
      calls++
      return calls === 1 ? [401] : [200, { code: 0, msg: 'ok', data: 1 }]
    })
    await client.get('/api/v1/docs')
    expect(loadAuth()?.user.displayName).toBe('管理员')
  })

  it('clears auth when refresh also fails', async () => {
    saveAuth(AUTH)
    bare.onPost('/api/v1/auth/refresh').reply(401)
    mock.onGet('/api/v1/docs').reply(401)

    await expect(client.get('/api/v1/docs')).rejects.toBeTruthy()
    expect(loadAuth()).toBeNull()
  })

  it('does not retry more than once', async () => {
    saveAuth(AUTH)
    bare.onPost('/api/v1/auth/refresh').reply(200, {
      code: 0,
      msg: 'ok',
      data: { accessToken: 'access-2', refreshToken: 'refresh-2' },
    })
    let calls = 0
    mock.onGet('/api/v1/docs').reply(() => {
      calls++
      return [401]
    })
    await expect(client.get('/api/v1/docs')).rejects.toBeTruthy()
    // 一次原始请求 + 一次重试,不能无限循环。
    expect(calls).toBe(2)
  })

  // refresh token 是一次性的。并发 401 各自去刷新会让第二个请求拿着已作废的
  // token 换,导致本来能救回的会话被登出。
  it('shares one refresh across concurrent 401s', async () => {
    saveAuth(AUTH)
    let refreshCalls = 0
    bare.onPost('/api/v1/auth/refresh').reply(() => {
      refreshCalls++
      return [200, { code: 0, msg: 'ok', data: { accessToken: 'a2', refreshToken: 'r2' } }]
    })

    const seen: Record<string, number> = {}
    mock.onGet(/\/api\/v1\/(docs|users)/).reply((cfg) => {
      const key = cfg.url ?? ''
      seen[key] = (seen[key] ?? 0) + 1
      return seen[key] === 1 ? [401] : [200, { code: 0, msg: 'ok', data: 1 }]
    })

    await Promise.all([client.get('/api/v1/docs'), client.get('/api/v1/users')])
    expect(refreshCalls).toBe(1)
  })

  it('attempts HttpOnly-cookie refresh without a local refresh token', async () => {
    bare.onPost('/api/v1/auth/refresh').reply(401)
    mock.onGet('/api/v1/docs').reply(401)
    await expect(client.get('/api/v1/docs')).rejects.toBeTruthy()
    expect(bare.history.post.length).toBe(1)
    expect(bare.history.post[0].data).toBe('{}')
  })
})
