import argon2 from 'argon2'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain)
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    // 哈希格式非法也算校验失败 —— 不能因为一条脏数据让登录接口 500。
    return false
  }
}

/**
 * 对称加密。
 *
 * 主密钥显式传入,不从环境变量偷读:隐式的全局依赖会让加密在配置缺失时
 * 于调用点抛错(而非启动时),表现为"某个写接口偶发 500"。密钥由 config
 * 在启动时校验并注入。
 */
export function deriveKey(masterKey: string): Buffer {
  // 允许 base64 或任意字符串:统一过一次 sha256 得到 32 字节。
  return createHash('sha256').update(masterKey).digest()
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

export function decryptSecret(blob: string, key: Buffer): string {
  const parts = blob.split('.')
  if (parts.length !== 3) throw new Error('密文格式非法')
  const [iv, tag, enc] = parts.map((s) => Buffer.from(s, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
