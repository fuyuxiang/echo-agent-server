import type { FastifyInstance } from 'fastify'
import { ok, fail } from '../reply.js'
import { requireAdmin } from '../auth.js'
import { createGroup, listGroups } from '../dao/groups.js'
import { createUser, listUsers, setUserGroup, setUserDisabled, findUserByName } from '../dao/users.js'

export function registerAdminRoutes(app: FastifyInstance): void {
  const { db } = app.deps
  const guard = { preHandler: [app.authenticate, requireAdmin] }

  app.get('/api/admin/groups', guard, async (_req, reply) => reply.send(ok(listGroups(db))))
  app.post('/api/admin/groups', guard, async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name) return reply.send(fail(1020, '组名不能为空'))
    return reply.send(ok(createGroup(db, name)))
  })

  app.get('/api/admin/users', guard, async (_req, reply) => reply.send(ok(listUsers(db))))
  app.post('/api/admin/users', guard, async (req, reply) => {
    const { username, password, role, groupId } = (req.body ?? {}) as any
    if (!username || !password) return reply.send(fail(1021, '缺少用户名或密码'))
    if (findUserByName(db, username)) return reply.send(fail(1022, '用户名已存在'))
    return reply.send(ok(await createUser(db, { username, password, role: role ?? 'member', groupId: groupId ?? null })))
  })
  app.patch('/api/admin/users/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { groupId, disabled } = (req.body ?? {}) as { groupId?: string; disabled?: boolean }
    if (groupId !== undefined) setUserGroup(db, id, groupId)
    if (disabled !== undefined) setUserDisabled(db, id, disabled)
    return reply.send(ok({ updated: true }))
  })
}
