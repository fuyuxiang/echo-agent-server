import type { AuthState, SessionUser } from '../types'

const KEY = 'echo-admin-auth'

export function saveAuth(state: AuthState): void {
  // 管理后台通过 HttpOnly cookie 轮换 refresh token；localStorage 只保留
  // 短期 access token。JSON 响应里的 refreshToken 仍供桌面客户端使用。
  localStorage.setItem(KEY, JSON.stringify({ ...state, refreshToken: '' }))
}

export function loadAuth(): AuthState | null {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthState
  } catch {
    // 脏数据当作未登录,而不是让整个应用在解析处崩掉。
    return null
  }
}

export function clearAuth(): void {
  localStorage.removeItem(KEY)
}

export function getToken(): string | null {
  return loadAuth()?.accessToken ?? null
}

export function getRefreshToken(): string | null {
  return loadAuth()?.refreshToken || null
}

export function getUser(): SessionUser | null {
  return loadAuth()?.user ?? null
}

/** access token 刷新后只替换它,保留其余会话信息。 */
export function updateTokens(accessToken: string, _refreshToken: string): void {
  const cur = loadAuth()
  if (!cur) return
  saveAuth({ ...cur, accessToken, refreshToken: '' })
}

/**
 * 前端的角色判断只用于决定展示哪些入口,不是权限边界 ——
 * 真正的鉴权在服务端,每个接口都会独立校验。
 */
export function isAdmin(): boolean {
  return getUser()?.role === 'admin'
}

export function canReview(): boolean {
  const role = getUser()?.role
  return role === 'admin' || role === 'curator'
}
