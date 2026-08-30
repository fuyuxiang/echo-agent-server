import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 托管管理后台的静态构建产物。
 *
 * 后台与 API 同源部署,省掉 CORS 配置与额外的 nginx 规则 —— 单机私有化部署
 * 下多一个需要配置的组件就多一处出错的地方。
 *
 * 未构建时不注册路由并给出提示,而不是让访问者看到一个空白页去猜原因。
 */
export function registerWeb(app: FastifyInstance, warn?: (m: string) => void): boolean {
  // dist 相对源码位置:开发时 src/ 与 web/ 同级,构建后 dist/ 与 web/ 同级。
  const candidates = [
    resolve(HERE, '../web/dist'),
    resolve(HERE, '../../web/dist'),
  ]
  const root = candidates.find((p) => existsSync(join(p, 'index.html')))

  if (!root) {
    warn?.(
      '管理后台未构建,/ 将不可访问。执行 cd web && npm install && npm run build 后重启',
    )
    return false
  }

  void app.register(async (scope) => {
    const staticPlugin = (await import('@fastify/static')).default
    // wildcard:false 让不存在的前端路径进入下方 notFoundHandler；默认的
    // wildcard 路由会先吃掉 /login、/documents 并直接返回 404。
    await scope.register(staticPlugin, { root, prefix: '/', wildcard: false })

    // SPA 路由回退:/documents、/review 这些路径在磁盘上没有对应文件,
    // 必须回 index.html 交给前端路由,否则刷新页面就 404。
    // 仅对 GET 且非 /api 前缀生效,不能吞掉真实的接口 404。
    scope.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api')) {
        return reply.code(404).send({ code: 4040, msg: '接口不存在', data: null })
      }
      return reply.sendFile('index.html')
    })
  })

  return true
}
