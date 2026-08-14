import type { DB } from '../db/index.js'

/**
 * 用户可见 scope 的解析。
 *
 * 每次查询实时计算,不缓存、不放进 JWT。代价是一次索引查询,换来的是
 * 权限撤销立即生效 —— 把 scope 塞进 token 会让"移出分组"直到 token
 * 过期前都不起作用。
 */
export function resolveUserScopes(db: DB, userId: string): string[] {
  const rows = db
    .prepare('SELECT scope_id FROM v_user_scopes WHERE user_id = ?')
    .all(userId) as { scope_id: string }[]
  return rows.map((r) => r.scope_id)
}

export interface AccessContext {
  userId: string
  scopeIds: string[]
  clearance: number
}

/** 一次取齐检索所需的全部权限信息。 */
export function loadAccessContext(db: DB, userId: string): AccessContext {
  const user = db
    .prepare("SELECT clearance FROM users WHERE id = ? AND status = 'active'")
    .get(userId) as { clearance: number } | undefined

  // 用户不存在或已禁用:返回空 scope 集,检索层据此直接返回空结果。
  if (!user) return { userId, scopeIds: [], clearance: 0 }

  return {
    userId,
    scopeIds: resolveUserScopes(db, userId),
    clearance: user.clearance
  }
}

/**
 * 判断用户能否访问指定 scope。用于文档下载、单条读取等按 id 的接口 ——
 * 这些接口不走检索链路,必须单独校验,否则可以靠猜 id 绕过 scope 限制。
 */
export function canAccessScope(ctx: AccessContext, scopeId: string): boolean {
  return ctx.scopeIds.includes(scopeId)
}

export function canAccessDocument(
  db: DB,
  ctx: AccessContext,
  docId: string
): boolean {
  const row = db
    .prepare('SELECT scope_id, sensitivity FROM documents WHERE id = ?')
    .get(docId) as { scope_id: string; sensitivity: number } | undefined
  if (!row) return false
  return canAccessScope(ctx, row.scope_id) && row.sensitivity <= ctx.clearance
}
