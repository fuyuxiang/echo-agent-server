import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DB } from '../../db/index.js'
import type { Config } from '../../config.js'
import type { Embedder } from '../../models/embedder.js'
import type { SourceType } from '../types.js'
import { parseDocument } from './parse.js'
import { chunkBlocks } from './chunk.js'
import { indexChunks, validateIngest } from './indexer.js'
import { activateDocumentVersion } from '../../dao/documents.js'
import type { OcrClient } from '../services/ocr.js'
import type { VlmClient } from '../services/vlm.js'

// 租约时长。worker 崩溃或进程重启后,超过这个时间的 running 任务会被重新
// 领取 —— 没有这个机制,文档会永久卡在 parsing 状态,而且没有任何报错。
export const LEASE_MS = 5 * 60_000
export const MAX_ATTEMPTS = 3

/** 指数退避:1s, 4s, 16s。瞬时故障(远端 API 抖动)靠重试自愈。 */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 4 ** attempts, 60_000)
}

export interface JobRow {
  id: string
  docId: string
  stage: 'parse' | 'chunk' | 'embed' | 'finalize'
  attempts: number
}

export function enqueueIngest(db: DB, docId: string): string {
  const id = randomUUID()
  const now = Date.now()
  db.transaction(() => {
    // 同一文档的旧任务作废,避免重复摄取产生两套 chunk。
    db.prepare("DELETE FROM ingest_jobs WHERE doc_id = ? AND state != 'done'").run(docId)
    db.prepare(
      `INSERT INTO ingest_jobs (id, doc_id, stage, state, attempts, created_at, updated_at)
       VALUES (?,?,'parse','queued',0,?,?)`
    ).run(id, docId, now, now)
    db.prepare(
      `UPDATE documents
          SET status = 'pending', fail_reason = NULL,
              fts_status = 'pending', vector_status = 'pending'
        WHERE id = ?`
    ).run(docId)
  })()
  return id
}

/** 领取一个待处理任务。包含超期租约的回收。 */
function claimNext(db: DB): JobRow | null {
  const now = Date.now()
  return db.transaction(() => {
    const job = db
      .prepare(
        `SELECT id, doc_id AS docId, stage, attempts
           FROM ingest_jobs
          WHERE state = 'queued'
             OR (state = 'running' AND (lease_until IS NULL OR lease_until < ?))
          ORDER BY created_at
          LIMIT 1`
      )
      .get(now) as JobRow | undefined
    if (!job) return null

    db.prepare(
      `UPDATE ingest_jobs
          SET state = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
        WHERE id = ?`
    ).run(now + LEASE_MS, now, job.id)
    return { ...job, attempts: job.attempts + 1 }
  })()
}

function setDocStatus(db: DB, docId: string, status: string, failReason?: string): void {
  db.prepare('UPDATE documents SET status = ?, fail_reason = ?, updated_at = ? WHERE id = ?').run(
    status,
    failReason ?? null,
    Date.now(),
    docId
  )
}

function advance(db: DB, jobId: string, stage: JobRow['stage']): void {
  db.prepare(
    "UPDATE ingest_jobs SET stage = ?, state = 'queued', lease_until = NULL, updated_at = ? WHERE id = ?"
  ).run(stage, Date.now(), jobId)
}

function complete(db: DB, jobId: string): void {
  db.prepare("UPDATE ingest_jobs SET state = 'done', updated_at = ? WHERE id = ?").run(
    Date.now(),
    jobId
  )
}

function requeue(db: DB, jobId: string, delayMs: number, error: string): void {
  // 用 lease_until 当"不早于"时间戳:queued 状态下它不参与领取条件,
  // 所以这里保持 running 并把租约推后,实现延迟重试。
  db.prepare(
    "UPDATE ingest_jobs SET state = 'running', lease_until = ?, last_error = ?, updated_at = ? WHERE id = ?"
  ).run(Date.now() + delayMs, error.slice(0, 500), Date.now(), jobId)
}

function failJob(db: DB, job: JobRow, error: string): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE ingest_jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?"
    ).run(error.slice(0, 500), Date.now(), job.id)
    setDocStatus(db, job.docId, 'failed', error.slice(0, 500))
    db.prepare(
      `UPDATE documents SET
         fts_status = CASE WHEN EXISTS (
           SELECT 1 FROM chunks c WHERE c.doc_id = documents.id
         ) THEN fts_status ELSE 'failed' END,
         vector_status = CASE WHEN EXISTS (
           SELECT 1 FROM chunk_vectors v
           JOIN chunks c ON c.id = v.chunk_id WHERE c.doc_id = documents.id
         ) THEN vector_status ELSE 'failed' END
       WHERE id = ?`
    ).run(job.docId)
  })()
}

type Live<T> = T | (() => T)

function current<T>(value: Live<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

export interface WorkerDeps {
  db: DB
  /** getter 形式让管理端热更新模型后 worker 的下一批任务立即使用新实例。 */
  cfg: Live<Config>
  embedder: Live<Embedder>
  ocrClient?: Live<OcrClient>
  vlmClient?: Live<VlmClient>
  log?: { warn(m: string): void; info?(m: string): void }
}

// 解析结果在阶段之间传递。放内存而非落库:重试会从 parse 重新开始,
// 中间产物没有持久化价值。
const parsedCache = new Map<string, { blocks: unknown[]; pageCount: number | null }>()

/**
 * 推进一个任务。返回 false 表示无待办任务。
 *
 * 单进程串行即可:嵌入是 CPU 密集,并发没有收益,反而会争抢 SQLite 写锁。
 */
export async function tick(deps: WorkerDeps): Promise<boolean> {
  const { db } = deps
  const job = claimNext(db)
  if (!job) return false

  try {
    const doc = db
      .prepare(
        'SELECT id, scope_id AS scopeId, source_type AS sourceType, storage_key AS storageKey, title FROM documents WHERE id = ?'
      )
      .get(job.docId) as
      | { id: string; scopeId: string; sourceType: SourceType; storageKey: string; title: string }
      | undefined

    if (!doc) {
      // 文档在摄取途中被删除:任务直接完结,不算失败。
      complete(db, job.id)
      parsedCache.delete(job.docId)
      return true
    }

    switch (job.stage) {
      case 'parse': {
        setDocStatus(db, doc.id, 'parsing')
        const cfg = current(deps.cfg)
        const abs = join(cfg.storageDir, doc.storageKey)
        const result = await parseDocument(abs, doc.sourceType, doc.title, doc.id, {
          ocrClient: deps.ocrClient ? current(deps.ocrClient) : undefined,
          vlmClient: deps.vlmClient ? current(deps.vlmClient) : undefined
        })
        parsedCache.set(doc.id, result as never)
        advance(db, job.id, 'chunk')
        break
      }

      case 'chunk': {
        setDocStatus(db, doc.id, 'chunking')
        // 缓存丢失(进程重启)则退回 parse 重做。
        if (!parsedCache.has(doc.id)) {
          advance(db, job.id, 'parse')
          break
        }
        advance(db, job.id, 'embed')
        break
      }

      case 'embed': {
        setDocStatus(db, doc.id, 'embedding')
        const parsed = parsedCache.get(doc.id)
        if (!parsed) {
          advance(db, job.id, 'parse')
          break
        }
        const drafts = chunkBlocks(parsed.blocks as never)
        const embedder = current(deps.embedder)
        const { chunkCount, vectorCount, vectorError } = await indexChunks(
          db,
          doc.id,
          drafts,
          embedder,
          embedder.model
        )

        db.prepare(
          `UPDATE documents
              SET fts_status = ?, vector_status = ?, index_model_version = ?
            WHERE id = ?`
        ).run(
          chunkCount > 0 ? 'ready' : 'failed',
          vectorCount === chunkCount && chunkCount > 0 ? 'ready' : 'degraded',
          embedder.model,
          doc.id
        )
        if (vectorError) {
          deps.log?.warn(`向量索引降级(${doc.title}): ${vectorError}`)
        }

        // 后置校验:扫描件 PDF 没有文本层时解析器返回空内容,流程会一路
        // ready 而检索永远命中不了。这里主动判失败,让管理员看到原因。
        const check = validateIngest(chunkCount, parsed.pageCount)
        if (!check.ok) {
          failJob(db, job, check.reason ?? '摄取校验未通过')
          parsedCache.delete(doc.id)
          return true
        }
        advance(db, job.id, 'finalize')
        break
      }

      case 'finalize': {
        const now = Date.now()
        db.transaction(() => {
          db.prepare(
            "UPDATE documents SET status = 'ready', indexed_at = ?, updated_at = ?, fail_reason = NULL WHERE id = ?"
          ).run(now, now, doc.id)
          activateDocumentVersion(db, doc.id, now)
          complete(db, job.id)
        })()
        parsedCache.delete(doc.id)
        deps.log?.info?.(`摄取完成: ${doc.title}`)
        break
      }
    }
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (job.attempts >= MAX_ATTEMPTS) {
      deps.log?.warn(`摄取失败(已重试 ${job.attempts} 次): ${msg}`)
      failJob(db, job, msg)
      parsedCache.delete(job.docId)
    } else {
      requeue(db, job.id, backoffMs(job.attempts), msg)
    }
    return true
  }
}

/** 排空队列。测试与"上传后立即处理"用。 */
export async function drain(deps: WorkerDeps, maxIterations = 1000): Promise<number> {
  let n = 0
  for (let i = 0; i < maxIterations; i++) {
    const did = await tick(deps)
    if (!did) break
    n++
  }
  return n
}

export class IngestWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private deps: WorkerDeps,
    private intervalMs = 1000
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // 防重入:上一轮还在跑就跳过,避免同一任务被两个循环同时推进。
      if (this.running) return
      this.running = true
      void tick(this.deps)
        .catch((e) => this.deps.log?.warn(`摄取 worker 异常: ${String(e)}`))
        .finally(() => {
          this.running = false
        })
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
