import client from './client'
import type {
  AuthState,
  SessionUser,
  User,
  Group,
  Scope,
  Role,
  DocListResult,
  DocumentItem,
  IngestStatus,
  OrgMemory,
  Promotion,
  ModelConfig,
  QualityOverview,
  AuditLog,
} from '../types'

// 所有路径都带 /api/v1 前缀。旧版无前缀的路径已不存在 —— 上一版前端调用
// /api/auth/login、/api/project-memory 等,新服务端全部 404。

// ── 认证 ──────────────────────────────────────────────────────────────────
export const login = (username: string, password: string): Promise<AuthState> =>
  client.post('/api/v1/auth/login', { username, password, deviceId: 'admin-web' })

export const logout = (): Promise<unknown> => client.post('/api/v1/auth/logout')

export const me = (): Promise<SessionUser> => client.get('/api/v1/me')

// ── 用户与分组 ────────────────────────────────────────────────────────────
export const listUsers = (): Promise<User[]> => client.get('/api/v1/admin/users')

export const createUser = (body: {
  username: string
  password: string
  displayName?: string
  email?: string
  role?: Role
  clearance?: number
  groupIds?: string[]
}): Promise<User> => client.post('/api/v1/admin/users', body)

export const updateUser = (
  id: string,
  body: {
    displayName?: string
    email?: string | null
    role?: Role
    status?: 'active' | 'disabled'
    clearance?: number
    groupIds?: string[]
  },
): Promise<User> => client.patch(`/api/v1/admin/users/${id}`, body)

export const resetPassword = (id: string, password: string): Promise<unknown> =>
  client.post(`/api/v1/admin/users/${id}/password`, { password })

/** 强制该用户全部设备下线。离职、凭证泄露时用。 */
export const revokeSessions = (id: string): Promise<unknown> =>
  client.post(`/api/v1/admin/users/${id}/revoke-sessions`)

export const listGroups = (): Promise<Group[]> => client.get('/api/v1/admin/groups')

export const createGroup = (body: {
  name: string
  parentId?: string | null
  description?: string
}): Promise<Group> => client.post('/api/v1/admin/groups', body)

export const listScopes = (): Promise<Scope[]> => client.get('/api/v1/scopes')

// ── 文档 ──────────────────────────────────────────────────────────────────
export const listDocs = (params: {
  scopeId?: string
  status?: string
  q?: string
  page?: number
  size?: number
}): Promise<DocListResult> => client.get('/api/v1/docs', { params })

export const getDoc = (id: string): Promise<DocumentItem & { tags: string[] }> =>
  client.get(`/api/v1/docs/${id}`)

export const getDocStatus = (id: string): Promise<IngestStatus> =>
  client.get(`/api/v1/docs/${id}/status`)

export const uploadDoc = (
  file: File,
  fields: {
    scopeId: string
    title?: string
    tags?: string
    sensitivity?: number
    volatility?: string
  },
): Promise<{ docId: string; status: string; dedup: boolean }> => {
  const form = new FormData()
  form.append('scopeId', fields.scopeId)
  if (fields.title) form.append('title', fields.title)
  if (fields.tags) form.append('tags', fields.tags)
  if (fields.sensitivity != null) form.append('sensitivity', String(fields.sensitivity))
  if (fields.volatility) form.append('volatility', fields.volatility)
  // file 必须最后 append:服务端按流式顺序读取,先拿到普通字段才能在读文件前
  // 完成权限与 scope 校验。
  form.append('file', file)
  return client.post('/api/v1/docs/upload', form)
}

export const patchDoc = (
  id: string,
  body: {
    title?: string
    scopeId?: string
    sensitivity?: number
    volatility?: string
    ownerId?: string | null
    tags?: string[]
  },
): Promise<unknown> => client.patch(`/api/v1/docs/${id}`, body)

export const reindexDoc = (id: string): Promise<unknown> =>
  client.post(`/api/v1/docs/${id}/reindex`)

export const deleteDoc = (id: string): Promise<unknown> => client.delete(`/api/v1/docs/${id}`)

// ── 审核 ──────────────────────────────────────────────────────────────────
export const listPromotions = (state = 'pending'): Promise<Promotion[]> =>
  client.get('/api/v1/promotions', { params: { state } })

/** edits 让审核人在通过前顺手修订,避免提交人反复返工。 */
export const approvePromotion = (
  id: string,
  body: { note?: string; edits?: Record<string, unknown> },
): Promise<{ state: string; resultId: string }> =>
  client.post(`/api/v1/promotions/${id}/approve`, body)

export const rejectPromotion = (id: string, note: string): Promise<unknown> =>
  client.post(`/api/v1/promotions/${id}/reject`, { note })

// ── 组织记忆 ──────────────────────────────────────────────────────────────
export const listMemories = (params: {
  kind?: string
  scope?: string
  status?: string
  q?: string
}): Promise<OrgMemory[]> => client.get('/api/v1/memories', { params })

export const patchMemory = (
  id: string,
  body: {
    content?: string
    rationale?: string | null
    confidence?: number
    validUntil?: number | null
    status?: string
  },
): Promise<unknown> => client.patch(`/api/v1/memories/${id}`, body)

export const retireMemory = (id: string): Promise<unknown> =>
  client.delete(`/api/v1/memories/${id}`)

// ── 检索(用于管理员自测知识库效果) ──────────────────────────────────────
export const retrieve = (body: {
  query: string
  limit?: number
  multiHop?: boolean
}): Promise<{
  chunks: {
    chunkId: string
    docId: string
    docTitle: string
    text: string
    score: number
    scopeKind: string
    citation: { page: number | null; heading: string; startMs: number | null }
    owner: { id: string; displayName: string } | null
    stale: boolean
  }[]
  memories: { id: string; kind: string; content: string }[]
  suggestAsk?: { userId: string; displayName: string; reason: string }[]
  diagnostics: {
    bm25Hits: number
    vecHits: number
    fusedCandidates: number
    rerankMs: number
    rerankSkipped: boolean
    totalMs: number
  }
}> => client.post('/api/v1/retrieve', body)

// ── 配置与质量 ────────────────────────────────────────────────────────────
export const getModelConfig = (): Promise<ModelConfig> => client.get('/api/v1/model-config')

export const putModelConfig = (body: {
  chatProvider: string
  chatModel: string
  chatBaseUrl?: string
  chatKey?: string
  embedModel: string
  embedDim: number
  rerankModel?: string
  vlmModel?: string
}): Promise<unknown> => client.put('/api/v1/admin/model-config', body)

export const getQuality = (days = 30): Promise<QualityOverview> =>
  client.get('/api/v1/admin/quality/overview', { params: { days } })

export const listAudit = (params: {
  action?: string
  actorId?: string
  from?: number
  to?: number
  limit?: number
}): Promise<AuditLog[]> => client.get('/api/v1/admin/audit', { params })
