import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseBackup, pruneDatabaseBackups } from '../src/db/backups.js'
import { openDb } from '../src/db/index.js'
import { testConfig } from '../src/config.js'
import { openProductionDatabase } from '../src/server.js'

describe('SQLite 生产备份', () => {
  it('创建可读取的一致性快照', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-backup-'))
    const dbPath = join(dir, 'source.db')
    const backupDir = join(dir, 'backups')
    const db = openDb({ path: dbPath })
    db.exec('CREATE TABLE backup_probe(value TEXT NOT NULL)')
    db.prepare('INSERT INTO backup_probe(value) VALUES (?)').run('durable')

    const path = await createDatabaseBackup(db, { backupDir, backupRetention: 3 }, 'manual')
    expect(existsSync(path)).toBe(true)
    const restored = openDb({ path, skipMigrate: true })
    expect(restored.prepare('SELECT value FROM backup_probe').get()).toEqual({ value: 'durable' })
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok')
    restored.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('只删除命名匹配的旧快照并保留最近 N 份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-prune-'))
    for (let index = 0; index < 4; index += 1) {
      const path = join(dir, `echo-${index}.db`)
      writeFileSync(path, String(index))
      const date = new Date(1_700_000_000_000 + index * 1000)
      utimesSync(path, date, date)
    }
    writeFileSync(join(dir, 'do-not-delete.txt'), 'safe')
    expect(pruneDatabaseBackups(dir, 2)).toHaveLength(2)
    expect(readdirSync(dir).sort()).toEqual(['do-not-delete.txt', 'echo-2.db', 'echo-3.db'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('已有数据库执行迁移前先留下旧 schema 快照', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-pre-migration-'))
    const dbPath = join(dir, 'echo.db')
    const backupDir = join(dir, 'backups')
    const old = openDb({ path: dbPath })
    old.pragma('user_version = 7')
    old.close()

    const migrated = await openProductionDatabase(testConfig({ dbPath, backupDir }))
    expect(migrated.pragma('user_version', { simple: true })).toBe(8)
    const backups = readdirSync(backupDir).filter((name) => name.includes('pre-migration'))
    expect(backups).toHaveLength(1)
    const snapshot = openDb({ path: join(backupDir, backups[0]), skipMigrate: true })
    expect(snapshot.pragma('user_version', { simple: true })).toBe(7)
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
    snapshot.close()
    migrated.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
