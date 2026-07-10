import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { fail } from '../reply.js'
import type { JwtClaims } from '../auth.js'

function groupOr401(req: FastifyRequest, reply: FastifyReply): string | null {
  const c = req.user as JwtClaims
  if (!c.groupId) {
    reply.send(fail(1010, '当前用户未分配分组'))
    return null
  }
  return c.groupId
}

export function registerKbRoutes(app: FastifyInstance): void {
  app.post('/api/kb/upload', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1501, '/api/kb/upload 待 Task C3 实现'))
  })

  app.get('/api/kb/documents', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1502, '/api/kb/documents 待 Task A4+ 实现'))
  })

  app.get('/api/kb/documents/:id', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1503, '/api/kb/documents/:id 待 Task A4+ 实现'))
  })

  app.get('/api/kb/documents/:id/status', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1504, '/api/kb/documents/:id/status 待 Task C3 实现'))
  })

  app.post('/api/kb/ask', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1505, '/api/kb/ask 待 Task G1 实现'))
  })

  app.post('/api/kb/qa/:id/feedback', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1506, '/api/kb/qa/:id/feedback 待 Task H4 实现'))
  })
}
