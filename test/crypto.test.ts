import { describe, it, expect } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  encryptSecret,
  decryptSecret,
  deriveKey
} from '../src/crypto.js'

// 主密钥显式传入,不再从 process.env 偷读 —— 隐式全局依赖会让加密在配置
// 缺失时于调用点抛错(而非启动时),表现为某个写接口偶发 500。
const key = deriveKey('test-master-key-value-for-unit-tests')

describe('crypto', () => {
  it('verifies a correct password and rejects wrong', async () => {
    const h = await hashPassword('s3cret')
    expect(await verifyPassword(h, 's3cret')).toBe(true)
    expect(await verifyPassword(h, 'wrong')).toBe(false)
  })

  it('treats a malformed hash as a failed check, not an error', async () => {
    // 一条脏数据不该让登录接口 500。
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false)
  })

  it('round-trips an encrypted secret', () => {
    const blob = encryptSecret('sk-12345', key)
    expect(blob).not.toContain('sk-12345')
    expect(decryptSecret(blob, key)).toBe('sk-12345')
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('sk-12345', key)
    const b = encryptSecret('sk-12345', key)
    expect(a).not.toBe(b)
    expect(decryptSecret(a, key)).toBe(decryptSecret(b, key))
  })

  it('rejects decryption with the wrong key', () => {
    const blob = encryptSecret('sk-12345', key)
    const other = deriveKey('a-completely-different-master-key')
    expect(() => decryptSecret(blob, other)).toThrow()
  })

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const blob = encryptSecret('sk-12345', key)
    const [iv, tag, enc] = blob.split('.')
    const flipped = Buffer.from(enc, 'base64')
    flipped[0] ^= 0xff
    const tampered = [iv, tag, flipped.toString('base64')].join('.')
    expect(() => decryptSecret(tampered, key)).toThrow()
  })

  it('rejects a malformed blob', () => {
    expect(() => decryptSecret('garbage', key)).toThrow('密文格式非法')
  })
})
