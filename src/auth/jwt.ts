import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.js'
import { fail } from '../reply.js'

/**
 * JWT 载荷。
 *
 * 刻意不放 groups / scopes / clearance:把可见范围写进 token 意味着
 * "移出分组"要等到 token 过期才生效。这里只放身份与版本号,权限每次
 * 查询从 v_user_scopes 实时算(见 auth/scopes.ts)。
 */
export interface JwtClaims {
  sub: string
  role: 'admin' | 'curator' | 'member'
  /** 与 users.token_version 比对。不一致即拒 —— 改密码/禁用可立即撤销全部 token。 */
  tv: number
  device?: string
}

export interface AuthedRequest extends FastifyRequest {
  claims: JwtClaims
}

/**
 * 校验 access token。
 *
 * 除了验签,还要回库比对 token_version —— 只验签的话,一个被禁用的用户
 * 在 token 到期前仍能畅通无阻。这一次查询是撤销能力的代价。
 */
export function makeAuthenticate(db: DB) {
  const stmt = db.prepare(
    "SELECT token_version AS tv, status, role FROM users WHERE id = ?"
  )

  return async function authenticate(
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    let claims: JwtClaims
    try {
      claims = await req.jwtVerify<JwtClaims>()
    } catch {
      return reply.code(401).send(fail(4011, '未认证或登录已过期'))
    }

    const row = stmt.get(claims.sub) as
      | { tv: number; status: string; role: string }
      | undefined

    if (!row || row.status !== 'active') {
      return reply.code(401).send(fail(4013, '账号不存在或已禁用'))
    }
    if (row.tv !== claims.tv) {
      return reply.code(401).send(fail(4014, '登录状态已失效,请重新登录'))
    }

    // 角色以库为准,不信 token —— 管理员降权后旧 token 不应保留权限。
    ;(req as AuthedRequest).claims = { ...claims, role: row.role as JwtClaims['role'] }
  }
}

export function requireRole(...roles: JwtClaims['role'][]) {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const claims = (req as AuthedRequest).claims
    if (!claims || !roles.includes(claims.role)) {
      return reply.code(403).send(fail(4031, '权限不足'))
    }
  }
}

export const requireAdmin = requireRole('admin')
export const requireCurator = requireRole('admin', 'curator')

// ── refresh token ────────────────────────────────────────────────────────
// 只存哈希:数据库泄露时明文 refresh token 等同于长期密码。

export interface RefreshRecord {
  userId: string
  deviceId: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function issueRefreshToken(
  db: DB,
  userId: string,
  deviceId: string,
  ttlMs: number
): string {
  const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
  db.prepare(
    `INSERT INTO refresh_tokens (token_hash, user_id, device_id, expires_at, created_at)
     VALUES (?,?,?,?,?)`
  ).run(hashToken(token), userId, deviceId, Date.now() + ttlMs, Date.now())
  return token
}

export function consumeRefreshToken(
  db: DB,
  token: string
): RefreshRecord | null {
  const hash = hashToken(token)
  const row = db
    .prepare(
      `SELECT user_id AS userId, device_id AS deviceId, expires_at AS expiresAt
         FROM refresh_tokens WHERE token_hash = ?`
    )
    .get(hash) as { userId: string; deviceId: string; expiresAt: number } | undefined

  if (!row) return null

  // 轮换:用过即弃,一个 refresh token 只能换一次 access token。
  // 重放会因查不到记录而失败。
  db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hash)

  if (row.expiresAt < Date.now()) return null
  return { userId: row.userId, deviceId: row.deviceId }
}

export function revokeDeviceTokens(db: DB, userId: string, deviceId: string): void {
  db.prepare(
    'DELETE FROM refresh_tokens WHERE user_id = ? AND device_id = ?'
  ).run(userId, deviceId)
}

export function revokeAllUserTokens(db: DB, userId: string): void {
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId)
  // 同时递增 token_version,让已签发的 access token 立即失效。
  db.prepare(
    'UPDATE users SET token_version = token_version + 1 WHERE id = ?'
  ).run(userId)
}

export function purgeExpiredRefreshTokens(db: DB): number {
  const info = db
    .prepare('DELETE FROM refresh_tokens WHERE expires_at < ?')
    .run(Date.now())
  return info.changes
}

// ── 登录限流 ─────────────────────────────────────────────────────────────
// 进程内计数即可:单机部署,且限流是防暴破不是防 DDoS(那是反代的活)。

interface Attempt {
  count: number
  firstAt: number
  lockedUntil: number
}

export class LoginThrottle {
  private attempts = new Map<string, Attempt>()

  constructor(
    private maxAttempts = 5,
    private windowMs = 5 * 60_000,
    private lockMs = 15 * 60_000
  ) {}

  /** 返回剩余锁定毫秒数;0 表示可以尝试。 */
  check(key: string): number {
    const a = this.attempts.get(key)
    if (!a) return 0
    const now = Date.now()
    if (a.lockedUntil > now) return a.lockedUntil - now
    if (now - a.firstAt > this.windowMs) {
      this.attempts.delete(key)
      return 0
    }
    return 0
  }

  recordFailure(key: string): void {
    const now = Date.now()
    const a = this.attempts.get(key)
    if (!a || now - a.firstAt > this.windowMs) {
      this.attempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 })
      return
    }
    a.count += 1
    if (a.count >= this.maxAttempts) {
      a.lockedUntil = now + this.lockMs
      a.count = 0
      a.firstAt = now
    }
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key)
  }
}

/** 常量时间比较,避免用户名枚举时序泄露。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
