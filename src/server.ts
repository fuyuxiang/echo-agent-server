import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { openDb, migrate, pendingMigrations, type DB } from './db/index.js'
import { createDatabaseBackup, DatabaseBackupScheduler } from './db/backups.js'
import { loadConfig, loadConfigFromDb, type Config } from './config.js'
import { countUsers, createUser } from './dao/users.js'
import { purgeExpiredRefreshTokens } from './auth/jwt.js'
import { IngestWorker } from './kb/ingest/worker.js'
import { buildApp } from './app.js'
import { VECTOR_INDEX_DIM } from './kb/vector-schema.js'

/**
 * 首次启动的初始化。
 *
 * org scope 必须存在,否则任何"全公司可见"的文档都无处安放,而且
 * v_user_scopes 会对所有人返回空集 —— 表现为"登录正常但什么都查不到"。
 */
export function ensureOrgScope(db: DB): string {
  const existing = db.prepare("SELECT id FROM scopes WHERE kind = 'org'").get() as
    | { id: string }
    | undefined
  if (existing) return existing.id

  const id = randomUUID()
  db.prepare("INSERT INTO scopes (id, kind, group_id, name) VALUES (?, 'org', NULL, ?)").run(
    id,
    '全公司'
  )
  return id
}

export async function ensureInitialAdmin(db: DB, cfg: Config): Promise<void> {
  if (countUsers(db) > 0) return

  const password = cfg.initialAdminPassword
  if (!password) {
    // 不生成默认弱密码:一个装完就有 admin/admin12345 的内网服务
    // 等于没有鉴权。这里直接拒绝启动,迫使部署方设定密码。
    throw new Error(
      '首次启动必须设置 ECHO_ADMIN_PASSWORD(至少 8 位),用于创建初始管理员账号'
    )
  }
  if (password.length < 8) {
    throw new Error('ECHO_ADMIN_PASSWORD 至少 8 位')
  }

  await createUser(db, {
    username: cfg.initialAdminUser,
    password,
    displayName: '管理员',
    role: 'admin',
    clearance: 2
  })
  // eslint-disable-next-line no-console
  console.log(`[echo-server] 已创建初始管理员: ${cfg.initialAdminUser}`)
}

/** Open an existing database safely: snapshot first, then apply pending migrations. */
export async function openProductionDatabase(cfg: Config): Promise<DB> {
  const databaseExisted = cfg.dbPath !== ':memory:' && existsSync(cfg.dbPath)
  const db = openDb({ path: cfg.dbPath, skipMigrate: true })
  try {
    const pending = pendingMigrations(db)
    const currentVersion = db.pragma('user_version', { simple: true }) as number
    if (databaseExisted && currentVersion > 0 && pending.length > 0) {
      const path = await createDatabaseBackup(db, cfg, 'pre-migration')
      // eslint-disable-next-line no-console
      console.log(`[echo-server] 迁移前数据库备份完成: ${path}`)
    }
    migrate(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export async function start(): Promise<void> {
  const envCfg = loadConfig()
  const db = await openProductionDatabase(envCfg)

  ensureOrgScope(db)
  await ensureInitialAdmin(db, envCfg)

  // 管理员在 Web 端修改的模型配置是权威配置，重启后也必须恢复。
  // 向量维度不匹配时拒绝启动，避免服务“看起来健康”却持续摄取失败。
  const cfg = loadConfigFromDb(db, envCfg)
  if (cfg.embedDim !== VECTOR_INDEX_DIM) {
    db.close()
    throw new Error(
      `嵌入维度 ${cfg.embedDim} 与当前向量索引维度 ${VECTOR_INDEX_DIM} 不一致，需要全量重建索引`
    )
  }

  const purged = purgeExpiredRefreshTokens(db)
  if (purged > 0) {
    // eslint-disable-next-line no-console
    console.log(`[echo-server] 清理过期 refresh token: ${purged}`)
  }

  const app = buildApp({ db, cfg })

  // 摄取 worker 必须在这里启动 —— 测试里都是手动 drain(),漏掉这一步的
  // 表现是"上传成功但文档永远停在 pending",且没有任何报错。
  const worker = new IngestWorker({
    db,
    cfg: () => app.deps.cfg,
    embedder: () => app.deps.embedder,
    ocrClient: () => app.deps.ocrClient,
    vlmClient: () => app.deps.vlmClient,
    transcriptionClient: () => app.deps.transcriptionClient,
    log: {
      warn: (m) => console.warn(`[echo-server] ${m}`),
      info: (m) => console.log(`[echo-server] ${m}`)
    }
  })
  worker.start()

  const backupScheduler = new DatabaseBackupScheduler(db, cfg, {
    info: (m) => console.log(`[echo-server] ${m}`),
    warn: (m) => console.warn(`[echo-server] ${m}`)
  })
  backupScheduler.start()

  await app.listen({ port: cfg.port, host: cfg.host })
  // eslint-disable-next-line no-console
  console.log(`[echo-server] 监听 ${cfg.host}:${cfg.port}`)

  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[echo-server] 收到 ${sig},正在退出`)
    worker.stop()
    await backupScheduler.stop()
    await app.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  start().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(`[echo-server] 启动失败: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
