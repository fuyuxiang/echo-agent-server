import client from './client'
import type { AuthState } from '../types'

export function login(username: string, password: string): Promise<AuthState> {
  return client.post<AuthState, AuthState>('/api/auth/login', { username, password })
}
