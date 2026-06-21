import argon2 from 'argon2'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain)
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

function key(): Buffer {
  const secret = process.env.ECHO_SERVER_SECRET
  if (!secret) throw new Error('ECHO_SERVER_SECRET not set')
  return createHash('sha256').update(secret).digest()
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

export function decryptSecret(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
