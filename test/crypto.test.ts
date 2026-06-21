import { describe, it, expect, beforeAll } from 'vitest'
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../src/crypto.js'

beforeAll(() => { process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!' })

describe('crypto', () => {
  it('verifies a correct password and rejects wrong', async () => {
    const h = await hashPassword('s3cret')
    expect(await verifyPassword(h, 's3cret')).toBe(true)
    expect(await verifyPassword(h, 'wrong')).toBe(false)
  })
  it('round-trips an encrypted secret', () => {
    const blob = encryptSecret('sk-12345')
    expect(blob).not.toContain('sk-12345')
    expect(decryptSecret(blob)).toBe('sk-12345')
  })
})
