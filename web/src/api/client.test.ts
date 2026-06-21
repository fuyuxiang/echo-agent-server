import { describe, expect, it, vi, beforeEach } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import client from './client'
import { saveAuth, clearAuth } from '../store/auth'

const mock = new MockAdapter(client)

beforeEach(() => {
  mock.reset()
  clearAuth()
})

describe('api client', () => {
  it('unwraps data when code===0', async () => {
    mock.onGet('/api/ping').reply(200, { code: 0, msg: 'ok', data: { pong: true } })
    const data = await client.get('/api/ping')
    expect(data).toEqual({ pong: true })
  })

  it('rejects with msg when code!==0', async () => {
    mock.onGet('/api/ping').reply(200, { code: 1022, msg: '用户名已存在', data: null })
    await expect(client.get('/api/ping')).rejects.toThrow('用户名已存在')
  })

  it('injects Authorization header when token exists', async () => {
    saveAuth({ token: 'tok123', user: { id: 'u', username: 'a', role: 'admin', groupId: null } })
    mock.onGet('/api/ping').reply((cfg) => {
      expect(cfg.headers?.Authorization).toBe('Bearer tok123')
      return [200, { code: 0, msg: 'ok', data: 1 }]
    })
    await client.get('/api/ping')
  })

  it('clears auth on HTTP 401', async () => {
    saveAuth({ token: 'tok123', user: { id: 'u', username: 'a', role: 'admin', groupId: null } })
    mock.onGet('/api/ping').reply(401)
    await expect(client.get('/api/ping')).rejects.toBeTruthy()
    expect(localStorage.getItem('echo-admin-auth')).toBeNull()
  })
})
