export interface Envelope<T> { code: number; msg: string; data: T }
export type Role = 'admin' | 'member'
export interface User { id: string; username: string; role: Role; groupId: string | null; disabled?: boolean }
export interface Group { id: string; name: string }
export interface ModelConfig {
  baseUrl: string | null
  modelName: string | null
  allowLocalOverride: boolean
  hasCredential: boolean
}
export interface Memory { id: string; content: string; tags: string[]; sourceUser?: string; createdAt?: number }
export interface MemoryHit extends Memory { score?: number }
export interface AuthState { token: string; user: User }
