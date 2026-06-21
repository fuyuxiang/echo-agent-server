import client from './client'
import type { Memory, MemoryHit } from '../types'

export function listMemories(p?: { limit?: number; offset?: number }): Promise<Memory[]> {
  return client.get<Memory[], Memory[]>('/api/project-memory', { params: p })
}
export function searchMemories(query: string, topK?: number): Promise<MemoryHit[]> {
  return client.post<MemoryHit[], MemoryHit[]>('/api/project-memory/search', { query, topK })
}
export function deleteMemory(id: string): Promise<{ deleted: boolean }> {
  return client.delete<{ deleted: boolean }, { deleted: boolean }>(`/api/project-memory/${id}`)
}
