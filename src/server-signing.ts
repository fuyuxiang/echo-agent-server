import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify
} from 'node:crypto'

// RFC 8410 Ed25519 PKCS#8 DER 前缀，后面紧跟 32 字节私钥 seed。
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function privateKey(masterKey: string) {
  const seed = createHash('sha256')
    .update('echo-agent-server-signing-v1\0')
    .update(masterKey)
    .digest()
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8'
  })
}

/** 签名给客户端缓存的策略和 Skill 包；公钥可公开，私钥从 master key 稳定派生。 */
export function signServerPayload(masterKey: string, payload: Buffer | string): string {
  return ed25519Sign(null, typeof payload === 'string' ? Buffer.from(payload) : payload, privateKey(masterKey))
    .toString('base64url')
}

export function serverSigningPublicKey(masterKey: string): string {
  return createPublicKey(privateKey(masterKey).export({ format: 'pem', type: 'pkcs8' }))
    .export({ format: 'der', type: 'spki' })
    .toString('base64')
}

/** 主要供回归测试与未来 CLI 验签使用。 */
export function verifyServerPayload(publicKeyBase64: string, payload: Buffer | string, signature: string): boolean {
  const key = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  return ed25519Verify(
    null,
    typeof payload === 'string' ? Buffer.from(payload) : payload,
    key,
    Buffer.from(signature, 'base64url')
  )
}
