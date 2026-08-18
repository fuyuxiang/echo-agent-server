import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { DB } from './db/index.js'
import type { Config } from './config.js'
import { createEmbedder } from './models/embedder.js'
import { createReranker } from './models/reranker.js'
import { Retriever } from './kb/retrieve/index.js'
import { makeAuthenticate, LoginThrottle } from './auth/jwt.js'
import { makeAudit } from './audit.js'
import { FsStorage } from './kb/storage/index.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerRetrieveRoutes } from './routes/retrieve.js'
import { registerModelConfigRoutes } from './routes/model-config.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerDocsRoutes } from './routes/docs.js'
import { registerPromotionRoutes } from './routes/promotions.js'
import { registerMemoryRoutes } from './routes/memories.js'
import { registerLlmRoutes } from './routes/llm.js'
import { registerSyncRoutes } from './routes/sync.js'
import { registerQualityRoutes } from './routes/quality.js'
import { registerMcpRoutes } from './mcp.js'
import { registerWeb } from './web.js'
import { createOcrClient } from './kb/services/ocr.js'
import { createVlmClient } from './kb/services/vlm.js'
import type { Deps, ThrottleLike } from './types.js'

export interface BuildOptions {
  db: DB
  cfg: Config
  /** 覆盖依赖,便于测试注入假实现。 */
  overrides?: Partial<Deps>
  /** 关闭静态托管。测试里不需要,也不该依赖 web/dist 是否已构建。 */
  serveWeb?: boolean
}

export function buildApp(opts: BuildOptions): FastifyInstance {
  const { db, cfg } = opts
  const app = Fastify({
    logger: false,
    // 上传走 multipart,JSON 体不需要很大;限制在此可挡住畸形大包。
    bodyLimit: 2 * 1024 * 1024
  })

  const warn = (m: string): void => {
    // eslint-disable-next-line no-console
    console.warn(`[echo-server] ${m}`)
  }

  const embedder = opts.overrides?.embedder ?? createEmbedder(cfg, warn)
  const reranker = opts.overrides?.reranker ?? createReranker(cfg, warn)
  const ocrClient = opts.overrides?.ocrClient ?? createOcrClient(cfg, warn)
  const vlmClient = opts.overrides?.vlmClient ?? createVlmClient(cfg, warn)
  const log = { warn }

  // Deps 在此构建,retriever / throttle 后续再补。原因:Retriever 内部持有
  // 同一份 deps 引用,PUT 替换 deps.embedder / deps.reranker 时,运行中的
  // Retriever(this.deps === deps)会自动看到新实例 —— 这就是"模型配置
  // 热加载不需要重建 Retriever"的核心机制。任何放在 Retriever 之外、不
  // 经由 deps 暴露的内部引用,都不会随之更新,这就是为什么要让它们共享
  // 同一个对象。
  const deps: Deps = {
    db,
    cfg,
    embedder,
    reranker,
    storage: opts.overrides?.storage ?? new FsStorage(cfg.storageDir),
    retriever: undefined as unknown as Retriever,
    ocrClient,
    vlmClient,
    throttle: undefined as unknown as ThrottleLike
  }
  deps.retriever =
    opts.overrides?.retriever ?? new Retriever(deps)
  // eval/CI 模式禁用登录限流:同一 IP+username 在 1 分钟内会跑过 5 次,
  // 内存限流会把 fixture 创建流程锁死。生产保留默认行为。
  deps.throttle =
    opts.overrides?.throttle ??
    (process.env.ECHO_DISABLE_LOGIN_THROTTLE === '1'
      ? { check: () => 0, recordFailure: () => undefined, recordSuccess: () => undefined }
      : new LoginThrottle())
  // 保留 overrides 整体覆盖能力(测试注入)。放在最后,使其优先级最高;
  // 但实际生产路径只通过 overrides 注入 retriever/throttle/storage,
  // 上述已赋值的字段不受 opts.overrides 影响。
  if (opts.overrides) Object.assign(deps, opts.overrides)

  app.decorate('deps', deps)
  app.decorate('audit', makeAudit(db, (e) => warn(`审计写入失败: ${String(e)}`)))

  // 安全中间件:helmet 给一组安全的默认响应头;CORS 仅允许显式白名单
  // origin;rate-limit 默认对所有路由启用,具体路由按 per-route 配置
  // 覆盖阈值。生产必须配 ECHO_CORS_ORIGINS,默认空表示"无跨域"。
  app.register(helmet, {
    // CSP 由 Fastify 静态服务管理,这里关闭默认 CSP,避免影响管理后台。
    contentSecurityPolicy: false
  })
  const corsOrigins = (cfg.corsOrigins ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
  })
  // 默认限流:对所有路由启用 200/min,作为粗粒度保护;具体路由会在
  // registerRetrieveRoutes/registerAuthRoutes 内通过 per-route config
  // 覆盖到方案要求的阈值。
  app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    // 匿名请求(无 Authorization)统一按 IP 限流;有 token 的请求在路由
    // 里按 sub 二次覆盖。这里不区分,保持简单。
    keyGenerator: (req) => req.ip
  })

  app.register(jwt, { secret: cfg.jwtSecret })
  app.register(multipart, { limits: { fileSize: cfg.maxUploadBytes, files: 1 } })
  app.decorate('authenticate', makeAuthenticate(db))

  app.get('/api/v1/health', async () => {
    // 暴露实际生效的模型能力。配置里写着 bge-m3 但跑的是占位实现时,
    // 从模型名看不出差别 —— 而两者的检索质量差一个量级。
    const ocrConfigured = deps.ocrClient.configured
    const vlmConfigured = deps.vlmClient.configured
    const allReal =
      deps.embedder.semantic &&
      deps.reranker.crossEncoder &&
      ocrConfigured &&
      vlmConfigured
    return {
      ok: true,
      version: 1,
      schemaVersion: db.pragma('user_version', { simple: true }),
      models: {
        embedder: deps.embedder.model,
        semantic: deps.embedder.semantic,
        reranker: deps.reranker.model,
        crossEncoder: deps.reranker.crossEncoder,
        ocr: { configured: ocrConfigured },
        vlm: { configured: vlmConfigured },
        productionReady: allReal,
        mode: allReal ? 'production' : 'placeholder'
      }
    }
  })

  registerAuthRoutes(app)
  registerRetrieveRoutes(app)
  registerModelConfigRoutes(app)
  registerAdminRoutes(app)
  registerDocsRoutes(app)
  registerPromotionRoutes(app)
  registerMemoryRoutes(app)
  registerLlmRoutes(app)
  registerSyncRoutes(app)
  registerQualityRoutes(app)
  registerMcpRoutes(app, {
    db,
    // 复用 deps.retriever,与 /api/v1/retrieve 共一份实例,共享 embedder/
    // reranker 引用 —— PUT 替换 deps.embedder 时,MCP 工具链立刻看到。
    retriever: deps.retriever,
    config: cfg,
    embedder: deps.embedder,
    reranker: deps.reranker
  })

  // 静态资源放最后注册:它带 SPA 回退的 notFoundHandler,先注册会抢在
  // 真实接口之前接管请求。测试时可关闭以免加载不存在的构建产物。
  if (opts.serveWeb !== false) registerWeb(app, warn)

  return app
}
