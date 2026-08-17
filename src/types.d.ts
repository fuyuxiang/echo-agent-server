import type { FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from './db/index.js'
import type { Config } from './config.js'
import type { Retriever } from './kb/retrieve/index.js'
import type { LoginThrottle } from './auth/jwt.js'
import type { Embedder } from './models/embedder.js'
import type { Reranker } from './models/reranker.js'
import type { Storage } from './kb/storage/index.js'
import type { AuditAction } from './audit.js'

export interface ThrottleLike {
  check(key: string): number
  recordFailure(key: string): void
  recordSuccess(key: string): void
}

export interface Deps {
  db: DB
  cfg: Config
  embedder: Embedder
  reranker: Reranker
  storage: Storage
  retriever: Retriever
  throttle: ThrottleLike
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    audit: (
      req: FastifyRequest | null,
      action: AuditAction,
      target?: string,
      detail?: Record<string, unknown>
    ) => void
  }
}
