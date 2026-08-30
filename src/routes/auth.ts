import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { verifyPassword } from '../crypto.js'
import {
  issueRefreshToken,
  consumeRefreshToken,
  revokeDeviceTokens,
  type JwtClaims,
  type AuthedRequest
} from '../auth/jwt.js'
import { findByUsername, findById, getUserGroups, touchLastSeen } from '../dao/users.js'
import { resolveUserScopes } from '../auth/scopes.js'

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  deviceId: z.string().min(1).default('default')
})

const RefreshSchema = z.object({ refreshToken: z.string().min(1) })

const REFRESH_COOKIE = 'echo_refresh'

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

function setRefreshCookie(
  reply: import('fastify').FastifyReply,
  token: string,
  maxAgeMs: number
): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  reply.header(
    'set-cookie',
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`
  )
}

function clearRefreshCookie(reply: import('fastify').FastifyReply): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  reply.header(
    'set-cookie',
    `${REFRESH_COOKIE}=; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  )
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const { db, cfg, throttle } = app.deps

  function sessionPayload(userId: string) {
    const user = findById(db, userId)!
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      clearance: user.clearance,
      groups: getUserGroups(db, userId),
      scopes: resolveUserScopes(db, userId)
    }
  }

  // 登录限流:方案 5.6 要求 5/min。Fastify 路由级 config.rateLimit 覆盖
  // 全局默认。匿名请求按 IP + username 联合 key。
  app.post(
    '/api/v1/auth/login',
    {
      config: {
        rateLimit: {
          max: cfg.rateLimitLoginPerMin > 0 ? cfg.rateLimitLoginPerMin : 1000,
          timeWindow: '1 minute',
          keyGenerator: (req) =>
            `${req.ip}:${(req.body as { username?: string })?.username ?? 'anon'}`
        }
      }
    },
    async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, '缺少用户名或密码'))
    const { username, password, deviceId } = parsed.data

    // 按 IP + 用户名双维度限流:只按用户名会让攻击者用一个不存在的账号
    // 把真实用户锁死,只按 IP 则挡不住分布式撞库里的单账号爆破。
    const key = `${req.ip}:${username}`
    const lockedFor = throttle.check(key)
    if (lockedFor > 0) {
      return reply
        .code(429)
        .send(fail(4291, `尝试过于频繁,请 ${Math.ceil(lockedFor / 60000)} 分钟后重试`))
    }

    const row = findByUsername(db, username)
    // 用户不存在时也走一次密码校验,避免响应时间差暴露账号是否存在。
    const passwordOk = row
      ? await verifyPassword(row.passwordHash, password)
      : await verifyPassword(
          '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000',
          password
        ).catch(() => false)

    if (!row || !passwordOk || row.status !== 'active') {
      throttle.recordFailure(key)
      app.audit(null, 'login_failed', username, { ip: req.ip })
      // 统一错误信息,不区分"不存在"与"密码错" —— 否则可枚举用户名。
      return reply.code(401).send(fail(4012, '用户名或密码错误'))
    }

    throttle.recordSuccess(key)
    touchLastSeen(db, row.id)

    const claims: JwtClaims = {
      sub: row.id,
      role: row.role,
      tv: row.tokenVersion,
      device: deviceId
    }
    const accessToken = app.jwt.sign(claims, { expiresIn: cfg.accessTokenTtl })
    // 同设备重复登录先撤旧 refresh token,避免一台设备累积多条记录。
    revokeDeviceTokens(db, row.id, deviceId)
    const refreshToken = issueRefreshToken(db, row.id, deviceId, cfg.refreshTokenTtlMs)
    setRefreshCookie(reply, refreshToken, cfg.refreshTokenTtlMs)

    app.audit(null, 'login', row.id, { ip: req.ip, deviceId })
    return reply.send(
      ok({ accessToken, refreshToken, user: sessionPayload(row.id) })
    )
    }
  )

  app.post('/api/v1/auth/refresh', async (req, reply) => {
    const parsed = RefreshSchema.partial().safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, 'refreshToken 格式错误'))
    const presentedRefreshToken = parsed.data.refreshToken
      ?? cookieValue(req.headers.cookie, REFRESH_COOKIE)
    if (!presentedRefreshToken) return reply.code(400).send(fail(4001, '缺少 refreshToken'))

    const rec = consumeRefreshToken(db, presentedRefreshToken)
    if (!rec) {
      clearRefreshCookie(reply)
      return reply.code(401).send(fail(4015, 'refresh token 无效或已过期'))
    }

    const user = findById(db, rec.userId)
    if (!user || user.status !== 'active') {
      clearRefreshCookie(reply)
      return reply.code(401).send(fail(4013, '账号不存在或已禁用'))
    }

    const claims: JwtClaims = {
      sub: user.id,
      role: user.role,
      tv: user.tokenVersion,
      device: rec.deviceId
    }
    const accessToken = app.jwt.sign(claims, { expiresIn: cfg.accessTokenTtl })
    // 轮换:换出新的 refresh token,旧的已在 consume 时删除。
    const nextRefreshToken = issueRefreshToken(
      db,
      user.id,
      rec.deviceId,
      cfg.refreshTokenTtlMs
    )
    setRefreshCookie(reply, nextRefreshToken, cfg.refreshTokenTtlMs)
    return reply.send(ok({ accessToken, refreshToken: nextRefreshToken }))
  })

  app.post('/api/v1/auth/logout', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    revokeDeviceTokens(db, claims.sub, claims.device ?? 'default')
    clearRefreshCookie(reply)
    app.audit(req, 'logout', claims.sub)
    return reply.code(200).send(ok({ loggedOut: true }))
  })

  app.get('/api/v1/me', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    return reply.send(ok(sessionPayload(claims.sub)))
  })
}
