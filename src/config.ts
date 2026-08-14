import { z } from 'zod'

// 启动即校验:缺失或格式错误的配置在 listen 之前失败,
// 而不是等到第一个请求打进来才炸。
const Schema = z.object({
  port: z.coerce.number().int().positive().default(8787),
  host: z.string().default('0.0.0.0'),
  dbPath: z.string().default('./data/echo.db'),
  storageDir: z.string().default('./data/storage'),
  modelDir: z.string().default('./data/models'),

  // 32 字节以上。用于签发/校验 JWT。
  jwtSecret: z.string().min(32, 'ECHO_JWT_SECRET 至少 32 字符'),
  // 加密模型 API Key 的主密钥。base64 解码后须为 32 字节(AES-256)。
  masterKey: z.string().min(1, 'ECHO_MASTER_KEY 必填'),

  accessTokenTtl: z.string().default('1h'),
  refreshTokenTtlMs: z.coerce.number().int().positive().default(30 * 24 * 3600_000),

  embedDim: z.coerce.number().int().positive().default(1024),
  embedModel: z.string().default('bge-m3'),
  rerankModel: z.string().default('bge-reranker-v2-m3'),

  // 远端嵌入/精排(不配则用本地 ONNX 或降级实现)
  embedUrl: z.string().optional(),
  embedKey: z.string().optional(),
  rerankUrl: z.string().optional(),
  rerankKey: z.string().optional(),

  maxUploadBytes: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  // volatile 文档超过这个天数即在答案里标注"可能过时"
  staleDays: z.coerce.number().int().positive().default(90),

  initialAdminUser: z.string().default('admin'),
  initialAdminPassword: z.string().optional(),

  corsOrigins: z.string().optional(),
  logLevel: z.string().default('info')
})

export type Config = z.infer<typeof Schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse({
    port: env.ECHO_PORT,
    host: env.ECHO_HOST,
    dbPath: env.ECHO_DB_PATH,
    storageDir: env.ECHO_STORAGE_DIR,
    modelDir: env.ECHO_MODEL_DIR,
    jwtSecret: env.ECHO_JWT_SECRET,
    masterKey: env.ECHO_MASTER_KEY,
    accessTokenTtl: env.ECHO_ACCESS_TTL,
    refreshTokenTtlMs: env.ECHO_REFRESH_TTL_MS,
    embedDim: env.ECHO_EMBED_DIM,
    embedModel: env.ECHO_EMBED_MODEL,
    rerankModel: env.ECHO_RERANK_MODEL,
    embedUrl: env.ECHO_EMBED_URL,
    embedKey: env.ECHO_EMBED_KEY,
    rerankUrl: env.ECHO_RERANK_URL,
    rerankKey: env.ECHO_RERANK_KEY,
    maxUploadBytes: env.ECHO_MAX_UPLOAD_BYTES,
    staleDays: env.ECHO_STALE_DAYS,
    initialAdminUser: env.ECHO_ADMIN_USER,
    initialAdminPassword: env.ECHO_ADMIN_PASSWORD,
    corsOrigins: env.ECHO_CORS_ORIGINS,
    logLevel: env.ECHO_LOG_LEVEL
  })

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`配置校验失败:\n${issues}`)
  }
  return parsed.data
}

/** 开发/测试用配置。生产走 loadConfig。 */
export function testConfig(over: Partial<Config> = {}): Config {
  return {
    ...Schema.parse({
      jwtSecret: 'test-secret-at-least-32-characters-long',
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      dbPath: ':memory:'
    }),
    ...over
  }
}
