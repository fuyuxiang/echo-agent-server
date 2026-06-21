import type { AuthState } from '../types'

const KEY = 'echo-admin-auth'

export function saveAuth(state: AuthState): void {
  localStorage.setItem(KEY, JSON.stringify(state))
}

export function loadAuth(): AuthState | null {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthState
  } catch {
    return null
  }
}

export function clearAuth(): void {
  localStorage.removeItem(KEY)
}

export function getToken(): string | null {
  return loadAuth()?.token ?? null
}
