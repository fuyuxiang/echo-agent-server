# Echo Agent 管理后台前端

React + TypeScript + Vite + Ant Design 5 的管理后台，对接 echo-agent-server。

## 开发
1. 确保后端已在 :8787 运行（仓库根目录 `./start.sh`）。
2. `cd web && npm install && npm run dev`，访问 http://localhost:5173 。
   dev server 通过代理将 `/api` 转发到 :8787。

## 构建
`npm run build` 产出 `dist/`，由任意静态服务器托管。
注意：
- 生产环境若与后端不同源，需后端配置 CORS（当前后端未配置）。
- 使用 BrowserRouter，静态托管时需配置 SPA fallback（将所有非静态资源路径重写到 `index.html`），否则刷新 `/users` 等深链或直接访问 `/login` 会 404。

## 测试
`npm run test`（Vitest + React Testing Library）。

## 说明
- 登录态来自登录时签发的 JWT（含 role/groupId 快照，有效期 7 天）。管理员修改某用户的角色或分组后，该用户需重新登录才会生效（菜单与记忆访问按 token 内的快照判断）。


## 功能
- 登录鉴权（JWT）
- 用户管理：列表、新建、改分组、启用/禁用（仅 admin）
- 分组管理：列表、新建（仅 admin）
- 模型配置：查看/修改，凭证不回显（仅 admin 可改）
- 记忆查看：列表、向量检索、删除（按分组隔离）
