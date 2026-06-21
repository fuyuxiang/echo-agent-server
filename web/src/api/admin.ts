import client from './client'
import type { User, Group } from '../types'

export function listUsers(): Promise<User[]> {
  return client.get<User[], User[]>('/api/admin/users')
}
export function createUser(p: {
  username: string; password: string; role?: string; groupId?: string | null
}): Promise<User> {
  return client.post<User, User>('/api/admin/users', p)
}
export function updateUser(
  id: string,
  p: { groupId?: string | null; disabled?: boolean },
): Promise<{ updated: boolean }> {
  return client.patch<{ updated: boolean }, { updated: boolean }>(`/api/admin/users/${id}`, p)
}
export function listGroups(): Promise<Group[]> {
  return client.get<Group[], Group[]>('/api/admin/groups')
}
export function createGroup(name: string): Promise<Group> {
  return client.post<Group, Group>('/api/admin/groups', { name })
}
