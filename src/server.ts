import type { DB } from './db.js'
import { getDb } from './db.js'
import { listUsers, createUser } from './dao/users.js'
import { createEmbeddingProvider } from './embedding.js'
import { buildApp } from './app.js'

export async function ensureInitialAdmin(db: DB): Promise<void> {
  if (listUsers(db).length > 0) return
  const username = process.env.ECHO_ADMIN_USER ?? 'admin'
  const password = process.env.ECHO_ADMIN_PASSWORD ?? 'admin12345'
  if (!process.env.ECHO_ADMIN_PASSWORD) {
    console.warn('[echo-server] ECHO_ADMIN_PASSWORD not set, using default weak password!')
  }
  await createUser(db, { username, password, role: 'admin', groupId: null })
}

export async function start(): Promise<void> {
  const db = getDb()
  await ensureInitialAdmin(db)
  const app = buildApp({ db, embed: createEmbeddingProvider() })
  const port = Number(process.env.ECHO_SERVER_PORT ?? 8787)
  await app.listen({ port, host: '0.0.0.0' })
  // eslint-disable-next-line no-console
  console.log(`echo-agent-server listening on :${port}`)
}

// 直接运行入口
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  start().catch((e) => { console.error(e); process.exit(1) })
}
