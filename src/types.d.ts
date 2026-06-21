import type { Deps } from './app.js'
declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps
    authenticate: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: 'member' | 'admin'; groupId: string | null }
    user: { sub: string; role: 'member' | 'admin'; groupId: string | null }
  }
}
