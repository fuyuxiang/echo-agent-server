import type { FastifyInstance } from 'fastify'
import { ok, fail } from '../reply.js'
import type { JwtClaims } from '../auth.js'
import { addMemory, searchMemories, listMemories, deleteMemory } from '../dao/memories.js'

export function registerMemoryRoutes(app: FastifyInstance): void {
  const { db, embed } = app.deps

  app.post('/api/project-memory', { preHandler: app.authenticate }, async (req, reply) => {
    const c = req.user as JwtClaims
    if (!c.groupId) return reply.send(fail(1010, '当前用户未分配分组'))
    const { content, tags } = (req.body ?? {}) as { content?: string; tags?: string[] }
    if (!content) return reply.send(fail(1011, '记忆内容不能为空'))
    const mem = await addMemory(db, embed, { groupId: c.groupId, content, tags: tags ?? [], sourceUser: c.sub })
    return reply.send(ok(mem))
  })

  app.post('/api/project-memory/search', { preHandler: app.authenticate }, async (req, reply) => {
    const c = req.user as JwtClaims
    if (!c.groupId) return reply.send(ok([]))
    const { query, topK } = (req.body ?? {}) as { query?: string; topK?: number }
    if (!query) return reply.send(fail(1012, '检索 query 不能为空'))
    const res = await searchMemories(db, embed, { groupId: c.groupId, query, topK: topK ?? 5 })
    return reply.send(ok(res))
  })

  app.get('/api/project-memory', { preHandler: app.authenticate }, async (req, reply) => {
    const c = req.user as JwtClaims
    if (!c.groupId) return reply.send(ok([]))
    const { limit, offset } = (req.query ?? {}) as { limit?: string; offset?: string }
    return reply.send(ok(listMemories(db, { groupId: c.groupId, limit: Number(limit ?? 50), offset: Number(offset ?? 0) })))
  })

  app.delete('/api/project-memory/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const c = req.user as JwtClaims
    if (!c.groupId) return reply.send(fail(1010, '当前用户未分配分组'))
    const { id } = req.params as { id: string }
    return reply.send(ok({ deleted: deleteMemory(db, { groupId: c.groupId, id }) }))
  })
}
