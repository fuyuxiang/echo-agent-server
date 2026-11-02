# Echo Agent 管理后台前端

React + TypeScript + Vite + Ant Design 5 的管理后台，对接 echo-agent-server。

## 开发
1. 确保后端已在 :8787 运行（仓库根目录 `./start.sh`）。
2. `cd web && npm install && npm run dev`，访问 http://localhost:9980 。
   dev server 通过代理将 `/api` 转发到 :8787。

## 构建
`npm run build` 产出 `dist/`，由任意静态服务器托管。
注意：
- 生产环境若与后端不同源，需后端配置 CORS（当前后端未配置）。
- 使用 BrowserRouter，静态托管时需配置 SPA fallback（将所有非静态资源路径重写到 `index.html`），否则刷新 `/users` 等深链或直接访问 `/login` 会 404。

## 测试
`npm run test`（Vitest + React Testing Library）。

## 界面风格

管理后台对齐同级 `echo-agent-desktop/src/styles/tokens.css` 的浅色主题：浅灰绿侧栏、近白内容区、深绿文字和薄荷绿主要操作。

- `src/theme.ts` 集中维护配色、字体和 Ant Design 组件主题，并向全局注入 `--echo-*` CSS 变量。
- `src/styles.css` 维护后台框架、登录页及响应式布局；页面中的辅助文字与状态颜色使用同一组变量。
- `src/components/EchoBrand.tsx` 统一产品字标；`AppLayout.tsx` 统一页面标题、导航和账号入口。

前端构建产物位于 `web/dist/`，由服务端同源托管。部署时需同步新的构建产物；Docker 部署需重新构建应用镜像。

## 访问与功能

- Web 后台只允许管理员登录；知识维护人和成员使用桌面端。
- `/api/v1/admin/auth/*` 提供独立的后台登录与 Cookie 续期，页面加载时向服务器校验管理员身份；停用或降权即时失效。
- 管理概览汇总安全检查、失败任务、用量核对与知识维护待办；不提供“我的提交”或个人通知入口。
- 知识质量包含质量分析和维护任务，避免重复导航；旧页面地址会跳转到对应管理页。
- 管理用户、分组与客户端，查看文档/经验/技能的自动安全检查结果，配置上游、用户密钥与配额，统计全组织用量，执行审计、检索自测和完整备份。
- 客户端登录与数据接口继续保留，成员的桌面端功能不受后台访问限制影响。
