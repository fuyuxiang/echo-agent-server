import type { Config } from '../config.js'
import { decryptSecret, deriveKey } from '../crypto.js'
import type { DB } from '../db/index.js'

interface ChatConfigRow {
  chatProvider: string
  chatModel: string
  chatBaseUrl: string | null
  encryptedKey: string | null
}

export interface EffectiveChatConfig {
  provider: string
  model: string | null
  baseUrl: string
  key: string | null
  configured: boolean
  source: 'database' | 'environment' | 'none'
  credentialError: boolean
}

/** Resolve the one chat configuration used by health checks and all callers. */
export function resolveChatConfig(db: DB, cfg: Config): EffectiveChatConfig {
  const row = db.prepare(
    `SELECT chat_provider AS chatProvider,
            chat_model AS chatModel,
            chat_base_url AS chatBaseUrl,
            chat_key_enc AS encryptedKey
       FROM model_configs WHERE id = 'default'`
  ).get() as ChatConfigRow | undefined

  let key = cfg.chatKey?.trim() || null
  let credentialError = false
  if (row?.encryptedKey) {
    try {
      key = decryptSecret(row.encryptedKey, deriveKey(cfg.masterKey)).trim() || null
    } catch {
      key = null
      credentialError = true
    }
  }

  const model = row?.chatModel?.trim() || cfg.chatModel?.trim() || null
  const source = row ? 'database' : model || key ? 'environment' : 'none'
  const baseUrl = row
    ? row.chatBaseUrl?.trim() || 'https://api.openai.com/v1'
    : cfg.chatBaseUrl?.trim() || 'https://api.openai.com/v1'
  return {
    provider: row?.chatProvider?.trim() || cfg.chatProvider,
    model,
    baseUrl: baseUrl.replace(/\/$/, ''),
    key,
    configured: !!model && !!key && !credentialError,
    source,
    credentialError
  }
}
