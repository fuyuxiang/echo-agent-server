import { randomUUID } from 'node:crypto'
import { openDb, type DB } from './db/index.js'
import { loadConfig, type Config } from './config.js'
import { countUsers, createUser } from './dao/users.js'
import { purgeExpiredRefreshTokens } from './auth/jwt.js'
import { IngestWorker } from './kb/ingest/worker.js'
import { buildApp } from './app.js'

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

export async function start(): Promise<void> {
  const cfg = loadConfig()
  const db = openDb({ path: cfg.dbPath })

  ensureOrgScope(db)
  await ensureInitialAdmin(db, cfg)

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
    cfg,
    embedder: app.deps.embedder,
    log: {
      warn: (m) => console.warn(`[echo-server] ${m}`),
      info: (m) => console.log(`[echo-server] ${m}`)
    }
  })
  worker.start()

  await app.listen({ port: cfg.port, host: cfg.host })
  // eslint-disable-next-line no-console
  console.log(`[echo-server] 监听 ${cfg.host}:${cfg.port}`)

  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[echo-server] 收到 ${sig},正在退出`)
    worker.stop()
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
