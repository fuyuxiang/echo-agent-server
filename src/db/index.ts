import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { indexableText } from '../kb/retrieve/text.js'

export type DB = Database.Database

const HERE = dirname(fileURLToPath(import.meta.url))

// 迁移以 .sql 文件按文件名排序执行,版本记在 user_version。
// 用文件而非 TS 数组:schema 是审查重点,SQL 原文比拼接字符串可读。
function migrationsDir(): string {
  return join(HERE, 'migrations')
}

export function pendingMigrations(db: DB): string[] {
  const applied = db.pragma('user_version', { simple: true }) as number
  const all = readdirSync(migrationsDir())
    .filter((f) => f.endsWith('.sql'))
    .sort()
  return all.slice(applied)
}

export function migrate(db: DB): number {
  const dir = migrationsDir()
  let applied = db.pragma('user_version', { simple: true }) as number
  for (const file of pendingMigrations(db)) {
    const sql = readFileSync(join(dir, file), 'utf8')
    // 每个迁移一个事务:中途失败则整体回滚,不留半套 schema。
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${applied + 1}`)
    })()
    applied += 1
  }
  return applied
}

export interface OpenOptions {
  path?: string
  /** 跳过迁移。仅用于检查已有库的状态。 */
  skipMigrate?: boolean
}

export function openDb(opts: OpenOptions = {}): DB {
  const path = opts.path ?? process.env.ECHO_DB_PATH ?? './data/echo.db'
  const isMemory = path === ':memory:' || path.startsWith('file::memory:')
  if (!isMemory) mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path)
  // WAL: 读不阻塞写,且 VACUUM INTO 可在线备份。
  db.pragma('journal_mode = WAL')
  // FK 约束默认关闭,必须显式开 —— 否则 ON DELETE CASCADE 静默失效,
  // 删文档会留下孤儿 chunk 继续被检索命中。
  db.pragma('foreign_keys = ON')
  // 等锁而非立即报 SQLITE_BUSY:摄取 worker 与请求并发写时更稳。
  db.pragma('busy_timeout = 5000')
  sqliteVec.load(db)
  // SQL trigger 也必须走与文档块一致的中文 bigram 归一化。将纯函数注册给
  // SQLite 后，直接 SQL 写入 org_memories（审核、迁移、测试）也不会绕过索引。
  db.function('echo_index_text', { deterministic: true }, indexableText)

  if (!opts.skipMigrate) migrate(db)
  return db
}

/** better-sqlite3 在线备份 API 在工作线程增量复制，避免阻塞 HTTP 事件循环。 */
export async function backupTo(db: DB, destPath: string): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true })
  await db.backup(destPath)
}
