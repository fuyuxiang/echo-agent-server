import client from './client'
import type { ModelConfig } from '../types'

export function getModelConfig(): Promise<ModelConfig> {
  return client.get<ModelConfig, ModelConfig>('/api/model-config')
}
export function updateModelConfig(p: {
  baseUrl?: string | null
  modelName?: string | null
  credential?: string
  allowLocalOverride: boolean
}): Promise<{ updated: boolean }> {
  return client.put<{ updated: boolean }, { updated: boolean }>('/api/admin/model-config', p)
}
