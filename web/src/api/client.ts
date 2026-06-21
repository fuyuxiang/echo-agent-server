import axios from 'axios'
import { message } from 'antd'
import { getToken, clearAuth } from '../store/auth'
import type { Envelope } from '../types'

const client = axios.create({ baseURL: '' })

client.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

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
  (error) => {
    if (error.response?.status === 401) {
      clearAuth()
      if (location.pathname !== '/login') location.assign('/login')
    } else {
      message.error(error.message || '网络错误')
    }
    return Promise.reject(error)
  },
)

export default client
