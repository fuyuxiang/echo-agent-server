import type { FastifyReply, FastifyRequest } from 'fastify'
import { fail } from './reply.js'

export interface JwtClaims { sub: string; role: 'member' | 'admin'; groupId: string | null }

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify()
  } catch {
    reply.code(401).send(fail(4011, '未认证或登录已过期'))
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const claims = req.user as JwtClaims
  if (claims?.role !== 'admin') {
    reply.code(403).send(fail(4031, '需要管理员权限'))
  }
}
