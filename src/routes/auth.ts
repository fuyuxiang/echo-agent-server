import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { verifyPassword } from '../crypto.js'
import {
  issueRefreshToken,
  consumeRefreshToken,
  revokeDeviceTokens,
  requireAdmin,
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
const ADMIN_REFRESH_COOKIE = 'echo_admin_refresh'
const ADMIN_DEVICE = 'admin-web'

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
  maxAgeMs: number,
  secureCookies: boolean,
  adminConsole = false
): void {
  const secure = secureCookies ? '; Secure' : ''
  reply.header(
    'set-cookie',
    `${adminConsole ? ADMIN_REFRESH_COOKIE : REFRESH_COOKIE}=${encodeURIComponent(token)}; Path=${adminConsole ? '/api/v1/admin/auth' : '/api/v1/auth'}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`
  )
}

function clearRefreshCookie(
  reply: import('fastify').FastifyReply,
  secureCookies: boolean,
  adminConsole = false
): void {
  const secure = secureCookies ? '; Secure' : ''
  reply.header(
    'set-cookie',
    `${adminConsole ? ADMIN_REFRESH_COOKIE : REFRESH_COOKIE}=; Path=${adminConsole ? '/api/v1/admin/auth' : '/api/v1/auth'}; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  )
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const { db, cfg, throttle } = app.deps
  const secureCookies = cfg.cookieSecure ?? process.env.NODE_ENV === 'production'

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
  for (const url of ['/api/v1/auth/login', '/api/v1/admin/auth/login']) {
  app.post(
    url,
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
    const { username, password } = parsed.data
    const adminEndpoint = url === '/api/v1/admin/auth/login'
    const deviceId = adminEndpoint ? ADMIN_DEVICE : parsed.data.deviceId
    const adminConsole = adminEndpoint || deviceId === ADMIN_DEVICE

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

    // 管理控制台与桌面端使用不同的登录入口；旧版 admin-web 请求同样收紧。
    if (adminConsole && row.role !== 'admin') {
      app.audit(null, 'login_failed', username, { ip: req.ip, adminConsole: true, reason: 'admin_required' })
      return reply.code(403).send(fail(4033, '管理后台仅限管理员登录，请使用 Echo Agent 桌面端'))
    }

    throttle.recordSuccess(key)
    touchLastSeen(db, row.id)

    const claims: JwtClaims = {
      sub: row.id,
      role: row.role,
      tv: row.tokenVersion,
      device: deviceId,
      ...(adminConsole ? { aud: 'admin-console' as const } : {})
    }
    const accessToken = app.jwt.sign(claims, { expiresIn: cfg.accessTokenTtl })
    // 同设备重复登录先撤旧 refresh token,避免一台设备累积多条记录。
    revokeDeviceTokens(db, row.id, deviceId)
    const refreshToken = issueRefreshToken(db, row.id, deviceId, cfg.refreshTokenTtlMs)
    setRefreshCookie(reply, refreshToken, cfg.refreshTokenTtlMs, secureCookies, adminEndpoint)

    app.audit(null, 'login', row.id, { ip: req.ip, deviceId })
    return reply.send(
      ok({ accessToken, refreshToken, user: sessionPayload(row.id) })
    )
    }
  )
  }

  for (const url of ['/api/v1/auth/refresh', '/api/v1/admin/auth/refresh']) {
  app.post(url, async (req, reply) => {
    const adminEndpoint = url === '/api/v1/admin/auth/refresh'
    const parsed = RefreshSchema.partial().safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(4001, 'refreshToken 格式错误'))
    const presentedRefreshToken = parsed.data.refreshToken
      ?? cookieValue(req.headers.cookie, adminEndpoint ? ADMIN_REFRESH_COOKIE : REFRESH_COOKIE)
    if (!presentedRefreshToken) return reply.code(400).send(fail(4001, '缺少 refreshToken'))

    const rec = consumeRefreshToken(db, presentedRefreshToken, adminEndpoint ? ADMIN_DEVICE : undefined)
    if (!rec) {
      clearRefreshCookie(reply, secureCookies, adminEndpoint)
      return reply.code(401).send(fail(4015, 'refresh token 无效或已过期'))
    }

    const user = findById(db, rec.userId)
    if (!user || user.status !== 'active') {
      clearRefreshCookie(reply, secureCookies, adminEndpoint)
      return reply.code(401).send(fail(4013, '账号不存在或已禁用'))
    }

    const adminConsole = adminEndpoint || rec.deviceId === ADMIN_DEVICE
    if (adminConsole && (user.role !== 'admin' || rec.deviceId !== ADMIN_DEVICE)) {
      clearRefreshCookie(reply, secureCookies, adminEndpoint)
      return reply.code(403).send(fail(4033, '管理后台仅限管理员登录，请使用 Echo Agent 桌面端'))
    }

    const claims: JwtClaims = {
      sub: user.id,
      role: user.role,
      tv: user.tokenVersion,
      device: rec.deviceId,
      ...(adminConsole ? { aud: 'admin-console' as const } : {})
    }
    const accessToken = app.jwt.sign(claims, { expiresIn: cfg.accessTokenTtl })
    // 轮换:换出新的 refresh token,旧的已在 consume 时删除。
    const nextRefreshToken = issueRefreshToken(
      db,
      user.id,
      rec.deviceId,
      cfg.refreshTokenTtlMs
    )
    setRefreshCookie(reply, nextRefreshToken, cfg.refreshTokenTtlMs, secureCookies, adminEndpoint)
    return reply.send(ok({ accessToken, refreshToken: nextRefreshToken }))
  })
  }

  for (const url of ['/api/v1/auth/logout', '/api/v1/admin/auth/logout']) {
  const adminEndpoint = url === '/api/v1/admin/auth/logout'
  app.post(url, { preHandler: adminEndpoint ? [app.authenticate, requireAdmin] : app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    revokeDeviceTokens(db, claims.sub, claims.device ?? 'default')
    clearRefreshCookie(reply, secureCookies, adminEndpoint)
    app.audit(req, 'logout', claims.sub)
    return reply.code(200).send(ok({ loggedOut: true }))
  })
  }

  for (const url of ['/api/v1/me', '/api/v1/admin/auth/me']) {
  app.get(url, { preHandler: url === '/api/v1/admin/auth/me' ? [app.authenticate, requireAdmin] : app.authenticate }, async (req, reply) => {
    const claims = (req as AuthedRequest).claims
    return reply.send(ok(sessionPayload(claims.sub)))
  })
  }
}
