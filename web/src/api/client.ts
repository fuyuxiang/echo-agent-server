import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { message } from 'antd'
import { getToken, getRefreshToken, updateTokens, clearAuth } from '../store/auth'
import type { Envelope } from '../types'

const client = axios.create({ baseURL: '' })

client.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

/**
 * 静默刷新。
 *
 * access token 只有 1 小时,不刷新的话管理员填一半表单就被踢回登录页。
 * 并发请求同时 401 时共用一个刷新 Promise,否则 refresh token 是一次性的,
 * 第二个请求会拿着已作废的 token 去换,导致本来能救回来的会话被登出。
 */
let refreshing: Promise<boolean> | null = null

async function doRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  try {
    // 用裸 axios,避免走本实例的拦截器造成递归。
    const res = await axios.post('/api/v1/auth/refresh', { refreshToken })
    const body = res.data as Envelope<{ accessToken: string; refreshToken: string }>
    if (body.code !== 0) return false
    updateTokens(body.data.accessToken, body.data.refreshToken)
    return true
  } catch {
    return false
  }
}

function toLogin(): void {
  clearAuth()
  if (location.pathname !== '/login') location.assign('/login')
}

client.interceptors.response.use(
  (response) => {
    const body = response.data as Envelope<unknown>
    if (body && typeof body.code === 'number') {
      if (body.code === 0) return body.data as never
      message.error(body.msg || '请求失败')
      return Promise.reject(new Error(body.msg || '请求失败'))
    }
    return response.data as never
  },
  async (error: AxiosError) => {
    const cfg = error.config as InternalAxiosRequestConfig & { _retried?: boolean }
    const status = error.response?.status

    if (status === 401 && cfg && !cfg._retried) {
      cfg._retried = true
      refreshing = refreshing ?? doRefresh().finally(() => { refreshing = null })
      const ok = await refreshing
      if (ok) return client.request(cfg)
      toLogin()
      return Promise.reject(error)
    }

    if (status === 401) {
      toLogin()
      return Promise.reject(error)
    }

    // 服务端的业务错误信息比 axios 的 "Request failed with status code 403"
    // 有用得多,优先展示它。
    const body = error.response?.data as Envelope<unknown> | undefined
    message.error(body?.msg || error.message || '网络错误')
    return Promise.reject(error)
  },
)

export default client
