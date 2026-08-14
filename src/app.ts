import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
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
import { registerSyncRoutes } from './routes/sync.js'
import { registerQualityRoutes } from './routes/quality.js'
import { registerWeb } from './web.js'
import type { Deps } from './types.js'

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
  const log = { warn }

  const deps: Deps = {
    db,
    cfg,
    embedder,
    reranker,
    storage: opts.overrides?.storage ?? new FsStorage(cfg.storageDir),
    retriever:
      opts.overrides?.retriever ??
      new Retriever({ db, cfg, embedder, reranker, log }),
    throttle: opts.overrides?.throttle ?? new LoginThrottle(),
    ...opts.overrides
  }

  app.decorate('deps', deps)
  app.decorate('audit', makeAudit(db, (e) => warn(`审计写入失败: ${String(e)}`)))
  app.register(jwt, { secret: cfg.jwtSecret })
  app.register(multipart, { limits: { fileSize: cfg.maxUploadBytes, files: 1 } })
  app.decorate('authenticate', makeAuthenticate(db))

  app.get('/api/v1/health', async () => ({
    ok: true,
    version: 1,
    schemaVersion: db.pragma('user_version', { simple: true }),
    // 暴露实际生效的模型能力。配置里写着 bge-m3 但跑的是占位实现时,
    // 从模型名看不出差别 —— 而两者的检索质量差一个量级。
    models: {
      embedder: deps.embedder.model,
      semantic: deps.embedder.semantic,
      reranker: deps.reranker.model,
      crossEncoder: deps.reranker.crossEncoder,
      productionReady: deps.embedder.semantic && deps.reranker.crossEncoder
    }
  }))

  registerAuthRoutes(app)
  registerRetrieveRoutes(app)
  registerModelConfigRoutes(app)
  registerAdminRoutes(app)
  registerDocsRoutes(app)
  registerPromotionRoutes(app)
  registerMemoryRoutes(app)
  registerSyncRoutes(app)
  registerQualityRoutes(app)

  // 静态资源放最后注册:它带 SPA 回退的 notFoundHandler,先注册会抢在
  // 真实接口之前接管请求。测试时可关闭以免加载不存在的构建产物。
  if (opts.serveWeb !== false) registerWeb(app, warn)

  return app
}
