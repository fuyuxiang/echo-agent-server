import { randomUUID } from 'node:crypto'
import type { DB } from '../db/index.js'
import { hashPassword } from '../crypto.js'

export interface UserRow {
  id: string
  username: string
  displayName: string
  email: string | null
  role: 'admin' | 'curator' | 'member'
  status: 'active' | 'disabled'
  clearance: number
  tokenVersion: number
  createdAt: number
  lastSeenAt: number | null
}

const SELECT = `
  id, username, display_name AS displayName, email, role, status,
  clearance, token_version AS tokenVersion, created_at AS createdAt,
  last_seen_at AS lastSeenAt
`

export function findByUsername(db: DB, username: string): (UserRow & { passwordHash: string }) | undefined {
  return db
    .prepare(`SELECT ${SELECT}, password_hash AS passwordHash FROM users WHERE username = ?`)
    .get(username) as (UserRow & { passwordHash: string }) | undefined
}

export function findById(db: DB, id: string): UserRow | undefined {
  return db.prepare(`SELECT ${SELECT} FROM users WHERE id = ?`).get(id) as UserRow | undefined
}

export function listUsers(db: DB): UserRow[] {
  return db.prepare(`SELECT ${SELECT} FROM users ORDER BY created_at`).all() as UserRow[]
}

export function countUsers(db: DB): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return r.n
}

export interface CreateUserInput {
  username: string
  password: string
  displayName?: string
  email?: string
  role?: UserRow['role']
  clearance?: number
  groupIds?: string[]
}

export async function createUser(db: DB, input: CreateUserInput): Promise<UserRow> {
  const id = randomUUID()
  const now = Date.now()
  const hash = await hashPassword(input.password)

  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, username, display_name, email, password_hash,
                          role, status, clearance, token_version, created_at)
       VALUES (?,?,?,?,?,?,'active',?,1,?)`
    ).run(
      id,
      input.username,
      input.displayName ?? input.username,
      input.email ?? null,
      hash,
      input.role ?? 'member',
      input.clearance ?? 0,
      now
    )
    for (const gid of input.groupIds ?? []) {
      db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?,?)').run(id, gid)
    }
  })()

  return findById(db, id)!
}

export interface UpdateUserInput {
  displayName?: string
  email?: string | null
  role?: UserRow['role']
  status?: UserRow['status']
  clearance?: number
}

/**
 * 更新用户。任何影响权限的字段变动都递增 token_version —— 否则降权/禁用
 * 要等到 access token 过期才生效。
 */
export function updateUser(db: DB, id: string, input: UpdateUserInput): UserRow | undefined {
  const sets: string[] = []
  const params: unknown[] = []

  if (input.displayName !== undefined) { sets.push('display_name = ?'); params.push(input.displayName) }
  if (input.email !== undefined) { sets.push('email = ?'); params.push(input.email) }
  if (input.role !== undefined) { sets.push('role = ?'); params.push(input.role) }
  if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
  if (input.clearance !== undefined) { sets.push('clearance = ?'); params.push(input.clearance) }
  if (sets.length === 0) return findById(db, id)

  const privilegeChanged =
    input.role !== undefined || input.status !== undefined || input.clearance !== undefined
  if (privilegeChanged) sets.push('token_version = token_version + 1')

  db.transaction(() => {
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
    if (privilegeChanged) {
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id)
    }
  })()

  return findById(db, id)
}

export async function changePassword(db: DB, id: string, newPassword: string): Promise<void> {
  const hash = await hashPassword(newPassword)
  db.transaction(() => {
    db.prepare(
      'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'
    ).run(hash, id)
    // 改密码等于登出所有设备。
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id)
  })()
}

export function setUserGroups(db: DB, userId: string, groupIds: string[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(userId)
    for (const gid of groupIds) {
      db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?,?)').run(userId, gid)
    }
    // 分组变动即可见范围变动。虽然 scope 是实时算的,但 refresh token
    // 一并作废可以让客户端及早感知需要重新同步缓存。
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId)
  })()
}

export function getUserGroups(db: DB, userId: string): { id: string; name: string }[] {
  return db
    .prepare(
      `SELECT g.id, g.name FROM groups g
         JOIN user_groups ug ON ug.group_id = g.id
        WHERE ug.user_id = ? ORDER BY g.name`
    )
    .all(userId) as { id: string; name: string }[]
}

export function touchLastSeen(db: DB, userId: string): void {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), userId)
}
