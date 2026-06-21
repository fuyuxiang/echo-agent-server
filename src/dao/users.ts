import { randomUUID } from 'node:crypto'
import type { DB } from '../db.js'
import { hashPassword } from '../crypto.js'

export interface User {
  id: string
  username: string
  role: 'member' | 'admin'
  groupId: string | null
  disabled: boolean
}

interface UserRow {
  id: string; username: string; password_hash: string
  role: 'member' | 'admin'; group_id: string | null; disabled: number
}

function toUser(r: UserRow): User {
  return { id: r.id, username: r.username, role: r.role, groupId: r.group_id, disabled: !!r.disabled }
}

export async function createUser(
  db: DB,
  input: { username: string; password: string; role: 'member' | 'admin'; groupId: string | null }
): Promise<User> {
  const id = randomUUID()
  const hash = await hashPassword(input.password)
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, group_id, disabled, created_at) VALUES (?,?,?,?,?,0,?)'
  ).run(id, input.username, hash, input.role, input.groupId, Date.now())
  return { id, username: input.username, role: input.role, groupId: input.groupId, disabled: false }
}

export function findUserRowByName(db: DB, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
}

export function findUserByName(db: DB, username: string): User | undefined {
  const r = findUserRowByName(db, username)
  return r ? toUser(r) : undefined
}

export function listUsers(db: DB): User[] {
  return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toUser)
}

export function setUserGroup(db: DB, userId: string, groupId: string): void {
  db.prepare('UPDATE users SET group_id = ? WHERE id = ?').run(groupId, userId)
}

export function setUserDisabled(db: DB, userId: string, disabled: boolean): void {
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId)
}
