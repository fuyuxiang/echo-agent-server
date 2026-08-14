export interface Envelope<T> {
  code: number
  msg: string
  data: T
}

// curator 是知识审核角色:能审核提升、管理文档,但不能改用户与模型配置。
export type Role = 'admin' | 'curator' | 'member'
export type UserStatus = 'active' | 'disabled'

export interface Group {
  id: string
  name: string
  parentId: string | null
  description?: string | null
  scopeId?: string | null
  memberCount?: number
}

export interface User {
  id: string
  username: string
  displayName: string
  email: string | null
  role: Role
  status: UserStatus
  // 0 公开 / 1 内部 / 2 机密。用户可见 sensitivity <= clearance 的文档。
  clearance: number
  tokenVersion: number
  createdAt: number
  lastSeenAt: number | null
  groups?: { id: string; name: string }[]
}

export type ScopeKind = 'org' | 'team'

export interface Scope {
  id: string
  kind: ScopeKind
  name: string
  groupId: string | null
}

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  clearance: number
  groups: { id: string; name: string }[]
  scopes: string[]
}

// token 不含 scope:可见范围由服务端每次实时计算,前端也不该缓存它做判断。
export interface AuthState {
  accessToken: string
  refreshToken: string
  user: SessionUser
}

export type DocStatus =
  | 'pending'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed'
  | 'archived'

export interface DocumentItem {
  id: string
  title: string
  sourceType: string
  status: DocStatus
  failReason: string | null
  byteSize: number
  sensitivity: number
  volatility: 'stable' | 'volatile'
  version: number
  createdAt: number
  updatedAt: number
  indexedAt: number | null
  scopeId: string
  scopeKind: ScopeKind
  scopeName: string
  ownerName: string | null
  chunkCount: number
}

export interface DocListResult {
  items: DocumentItem[]
  total: number
  page: number
  size: number
}

export interface IngestStatus {
  status: DocStatus
  failReason: string | null
  progress: number
  job: {
    stage: string
    state: string
    attempts: number
    lastError: string | null
  } | null
}

export type MemoryKind = 'fact' | 'decision' | 'convention' | 'pitfall' | 'howto'

export interface OrgMemory {
  id: string
  kind: MemoryKind
  content: string
  rationale: string | null
  confidence: number
  hitCount: number
  validUntil: number | null
  status: 'active' | 'superseded' | 'retired'
  createdAt: number
  updatedAt: number
  scopeId: string
  scopeKind: ScopeKind
  scopeName: string
  authorName: string | null
}

export type PromotionState = 'pending' | 'approved' | 'rejected' | 'withdrawn'
export type PromotionSource = 'meeting' | 'qa' | 'task' | 'manual'

export interface MemoryPayload {
  kind: MemoryKind
  content: string
  rationale?: string
  evidence?: { type: string; id: string; loc?: string }[]
  validUntil?: number
}

export interface DocumentPayload {
  title: string
  text: string
  sourceType?: string
  volatility?: 'stable' | 'volatile'
}

export interface Promotion {
  id: string
  payloadType: 'document' | 'memory'
  payload: MemoryPayload | DocumentPayload
  source: PromotionSource
  state: PromotionState
  createdAt: number
  reviewedAt?: number | null
  reviewNote?: string | null
  resultId?: string | null
  targetScope?: string
  scopeName: string
  scopeKind: ScopeKind
  submitterId?: string
  submitterName?: string
  reviewerName?: string | null
}

export interface ModelConfig {
  configured: boolean
  chatProvider: string | null
  chatModel: string | null
  chatBaseUrl?: string | null
  embedModel: string | null
  embedDim: number | null
  rerankModel?: string | null
  vlmModel?: string | null
  hasCredential: boolean
  // 服务端代理推理,Key 不下发客户端。
  proxied: boolean
  updatedAt?: number
}

export interface QualityOverview {
  windowDays: number
  total: number
  unansweredRate: number
  negativeRate: number
  // 超过 25% 说明客户端 router 判定过松,token 在浪费。
  agenticRate: number
  latency: { avg: number | null; p50: number | null; p95: number | null }
  blindSpots: { question: string; n: number }[]
  negativeTop: { question: string; feedback: string; createdAt: number }[]
  unusedDocs: { id: string; title: string; createdAt: number }[]
  docStats: { status: string; n: number }[]
}

export interface AuditLog {
  id: string
  actorId: string | null
  actorName: string | null
  action: string
  target: string | null
  detail: string | null
  ip: string | null
  createdAt: number
}
