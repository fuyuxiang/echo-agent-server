import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import type { DB } from './db.js'
import type { EmbeddingProvider } from './embedding.js'
import { ok, fail } from './reply.js'
import { findUserRowByName } from './dao/users.js'
import { verifyPassword } from './crypto.js'
import { authenticate, type JwtClaims } from './auth.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerModelConfigRoutes } from './routes/model-config.js'

export interface Deps { db: DB; embed: EmbeddingProvider }

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false })
  app.decorate('deps', deps)
  app.register(jwt, { secret: process.env.ECHO_SERVER_SECRET ?? 'dev-secret' })
  app.decorate('authenticate', authenticate)

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!username || !password) return reply.send(fail(1001, '缺少用户名或密码'))
    const row = findUserRowByName(deps.db, username)
    if (!row || row.disabled) return reply.send(fail(1002, '用户不存在或已禁用'))
    if (!(await verifyPassword(row.password_hash, password))) return reply.send(fail(1003, '密码错误'))
    const claims: JwtClaims = { sub: row.id, role: row.role, groupId: row.group_id }
    const token = app.jwt.sign(claims, { expiresIn: '7d' })
    return reply.send(ok({ token, user: { id: row.id, username: row.username, role: row.role, groupId: row.group_id } }))
  })

  registerMemoryRoutes(app)
  registerAdminRoutes(app)
  registerModelConfigRoutes(app)

  return app
}
