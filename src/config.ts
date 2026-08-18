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

  // OCR / VLM 远端服务(可选)。不配则扫描件与图片落到占位实现,失败显式化
  // 而非静默产出空索引。
  ocrUrl: z.string().optional(),
  vlmUrl: z.string().optional(),
  vlmKey: z.string().optional(),

  maxUploadBytes: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  // volatile 文档超过这个天数即在答案里标注"可能过时"
  staleDays: z.coerce.number().int().positive().default(90),

  initialAdminUser: z.string().default('admin'),
  initialAdminPassword: z.string().optional(),

  // CORS 白名单:逗号分隔的 origin。生产必须配置,留空则拒绝跨域,
  // 避免浏览器侧被任意来源访问。
  corsOrigins: z.string().optional(),

  // 限流阈值。覆盖方案 5.6:retrieve 60/min、llm 20/min、login 5/min。
  // 设置为 0 表示禁用该限流(测试/开发场景)。
  rateLimitRetrievePerMin: z.coerce.number().int().nonnegative().default(60),
  rateLimitLlmPerMin: z.coerce.number().int().nonnegative().default(20),
  rateLimitLoginPerMin: z.coerce.number().int().nonnegative().default(5),

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
    ocrUrl: env.ECHO_OCR_URL,
    vlmUrl: env.ECHO_VLM_URL,
    vlmKey: env.ECHO_VLM_KEY,
    maxUploadBytes: env.ECHO_MAX_UPLOAD_BYTES,
    staleDays: env.ECHO_STALE_DAYS,
    initialAdminUser: env.ECHO_ADMIN_USER,
    initialAdminPassword: env.ECHO_ADMIN_PASSWORD,
    corsOrigins: env.ECHO_CORS_ORIGINS,
    rateLimitRetrievePerMin: env.ECHO_RATE_LIMIT_RETRIEVE,
    rateLimitLlmPerMin: env.ECHO_RATE_LIMIT_LLM,
    rateLimitLoginPerMin: env.ECHO_RATE_LIMIT_LOGIN,
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

/**
 * 从 DB 的 model_configs 表覆盖 baseCfg 中的模型字段。
 *
 * 用途:支持模型配置热加载。管理员 PUT /api/v1/admin/model-config 后,
 * 服务端无需重启即可用本函数读到最新 cfg,据此重建 embedder / reranker。
 *
 * 设计:
 *   · DB 只覆盖"模型相关"字段(embedModel / embedDim / rerankModel);
 *   · 基础设施字段(jwtSecret / masterKey / 路径 / 限流等)不在 DB 中,
 *     一律走 baseCfg,避免运营误改 admin 密码或 storage 路径后服务
 *     无感重启带来事故;
 *   · 不存在 DB 行时直接返回 baseCfg(尚未配置)。
 */
export function loadConfigFromDb(
  db: import('./db/index.js').DB,
  baseCfg: Config
): Config {
  const row = db
    .prepare(
      `SELECT embed_model AS embedModel,
              embed_dim   AS embedDim,
              rerank_model AS rerankModel
         FROM model_configs WHERE id = 'default'`
    )
    .get() as
    | { embedModel: string; embedDim: number; rerankModel: string | null }
    | undefined
  if (!row) return baseCfg
  return {
    ...baseCfg,
    embedModel: row.embedModel,
    embedDim: row.embedDim,
    rerankModel: row.rerankModel ?? baseCfg.rerankModel
  }
}
