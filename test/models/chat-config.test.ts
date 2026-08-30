import { describe, expect, it } from 'vitest'
import { testConfig } from '../../src/config.js'
import { encryptSecret, deriveKey } from '../../src/crypto.js'
import { openDb } from '../../src/db/index.js'
import { resolveChatConfig } from '../../src/models/chat-config.js'

describe('聊天模型有效配置', () => {
  it('新数据库使用环境变量配置', () => {
    const db = openDb({ path: ':memory:' })
    const chat = resolveChatConfig(db, testConfig({
      chatModel: 'env-model',
      chatBaseUrl: 'https://chat.example/v1/',
      chatKey: 'env-key'
    }))
    expect(chat).toMatchObject({
      configured: true,
      model: 'env-model',
      baseUrl: 'https://chat.example/v1',
      source: 'environment',
      credentialError: false
    })
    db.close()
  })

  it('数据库配置覆盖环境模型和密钥', () => {
    const db = openDb({ path: ':memory:' })
    const cfg = testConfig({ chatModel: 'env-model', chatKey: 'env-key' })
    db.prepare(
      `INSERT INTO model_configs
         (id, chat_provider, chat_model, chat_base_url, chat_key_enc,
          embed_model, embed_dim, updated_at)
       VALUES ('default','openai','db-model','https://db.example/v1',?, 'bge-m3',1024,?)`
    ).run(encryptSecret('db-key', deriveKey(cfg.masterKey)), Date.now())
    const chat = resolveChatConfig(db, cfg)
    expect(chat).toMatchObject({ configured: true, model: 'db-model', source: 'database' })
    expect(chat.key).toBe('db-key')
    db.close()
  })

  it('损坏的数据库密钥不静默回退环境密钥', () => {
    const db = openDb({ path: ':memory:' })
    const cfg = testConfig({ chatModel: 'env-model', chatKey: 'env-key' })
    db.prepare(
      `INSERT INTO model_configs
         (id, chat_provider, chat_model, chat_key_enc, embed_model, embed_dim, updated_at)
       VALUES ('default','openai','db-model','not-ciphertext','bge-m3',1024,?)`
    ).run(Date.now())
    expect(resolveChatConfig(db, cfg)).toMatchObject({
      configured: false,
      credentialError: true,
      source: 'database',
      key: null
    })
    db.close()
  })

  it('后台配置留空地址表示官方接口，不继承旧环境网关', () => {
    const db = openDb({ path: ':memory:' })
    const cfg = testConfig({ chatBaseUrl: 'https://old-gateway.example/v1', chatKey: 'env-key' })
    db.prepare(
      `INSERT INTO model_configs
         (id, chat_provider, chat_model, chat_base_url, embed_model, embed_dim, updated_at)
       VALUES ('default','openai','db-model',NULL,'bge-m3',1024,?)`
    ).run(Date.now())
    expect(resolveChatConfig(db, cfg).baseUrl).toBe('https://api.openai.com/v1')
    db.close()
  })
})
