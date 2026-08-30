import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Config } from '../config.js'
import { backupTo, type DB } from './index.js'

export type BackupReason = 'pre-migration' | 'scheduled' | 'manual'

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function pruneDatabaseBackups(directory: string, retention: number): string[] {
  const dir = resolve(directory)
  mkdirSync(dir, { recursive: true })
  const files = readdirSync(dir)
    .filter((name) => /^echo-.*\.db$/.test(name))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const removed: string[] = []
  for (const file of files.slice(retention)) {
    const path = join(dir, file.name)
    unlinkSync(path)
    removed.push(path)
  }
  return removed
}

/** Create a consistent SQLite snapshot and enforce the configured retention. */
export async function createDatabaseBackup(
  db: DB,
  cfg: Pick<Config, 'backupDir' | 'backupRetention'>,
  reason: BackupReason,
  now = new Date()
): Promise<string> {
  const dir = resolve(cfg.backupDir)
  mkdirSync(dir, { recursive: true })
  const version = db.pragma('user_version', { simple: true }) as number
  const id = randomUUID().slice(0, 8)
  const path = join(dir, `echo-${timestamp(now)}-v${version}-${reason}-${id}.db`)
  await backupTo(db, path)
  pruneDatabaseBackups(dir, cfg.backupRetention)
  return path
}

export class DatabaseBackupScheduler {
  private timer: NodeJS.Timeout | null = null
  private active: Promise<void> | null = null

  constructor(
    private readonly db: DB,
    private readonly cfg: Pick<Config, 'backupDir' | 'backupIntervalHours' | 'backupRetention'>,
    private readonly log: { info(message: string): void; warn(message: string): void }
  ) {}

  start(): void {
    if (this.timer || this.cfg.backupIntervalHours <= 0) return
    const intervalMs = this.cfg.backupIntervalHours * 3600_000
    this.timer = setInterval(() => void this.runNow(), intervalMs)
    this.timer.unref?.()
  }

  async runNow(): Promise<void> {
    if (this.active) return this.active
    const task = this.performBackup()
    this.active = task
    await task
    if (this.active === task) this.active = null
  }

  private async performBackup(): Promise<void> {
    try {
      const path = await createDatabaseBackup(this.db, this.cfg, 'scheduled')
      this.log.info(`数据库定时备份完成: ${path}`)
    } catch (error) {
      this.log.warn(`数据库定时备份失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.active
  }
}
