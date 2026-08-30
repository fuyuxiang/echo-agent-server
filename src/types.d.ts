import type { FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from './db/index.js'
import type { Config } from './config.js'
import type { Retriever } from './kb/retrieve/index.js'
import type { LoginThrottle } from './auth/jwt.js'
import type { Embedder } from './models/embedder.js'
import type { Reranker } from './models/reranker.js'
import type { Storage } from './kb/storage/index.js'
import type { OcrClient } from './kb/services/ocr.js'
import type { VlmClient } from './kb/services/vlm.js'
import type { TranscriptionClient } from './kb/services/transcription.js'
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
  /** OCR 客户端。app.ts 注入;生产就绪时 configured=true。 */
  ocrClient: OcrClient
  /** VLM 客户端。app.ts 注入;生产就绪时 configured=true。 */
  vlmClient: VlmClient
  /** OpenAI-compatible speech-to-text client used by audio/video ingestion. */
  transcriptionClient: TranscriptionClient
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
