import { defineConfig } from 'vitest/config'

/**
 * 根项目 vitest 配置。
 *
 * 设计原则:
 *   - 主测试集只跑 Node 端后端代码(test/ 与 src/)。
 *   - web/ 子项目是独立的浏览器 SPA(React + Ant Design),
 *     它使用 jsdom 环境并依赖 localStorage / window 等浏览器全局,
 *     一旦被根 vitest 误卷入会因环境差异全部失败。
 *   - 因此这里显式排除 web/src,避免 Node 环境跑浏览器测试;
 *     浏览器测试由 `npm test --prefix web` 在 jsdom 下单独运行。
 */
export default defineConfig({
  test: {
    globals: false,
    // 后端测试是 Node 进程,不带 jsdom / happy-dom。
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts', 'test/e2e/**/*.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // 浏览器侧 SPA 测试用 jsdom 单独跑。
      'web/**',
    ],
  },
})
