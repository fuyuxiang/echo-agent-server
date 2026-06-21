# Echo Agent Server 管理后台前端设计

- 日期：2026-06-21
- 状态：已确认，待实现
- 关联后端：`echo-agent-server`（Fastify + SQLite，纯后端 API）

## 1. 背景与目标

`echo-agent-server` 是给别的 agent/应用调用的后端服务，提供账号分组、JWT 鉴权、项目记忆向量检索（组隔离）、模型配置下发能力。目前只有 HTTP API，没有人可操作的界面。

本项目为它构建一个**企业级生产系统样式的管理后台前端**，定位为「管理员后台 + 记忆查看/检索台」，覆盖两类需求：

1. **管理**：用户、分组、模型配置的增改与启用禁用，替代手动 curl/Postman 操作。
2. **查看/调试**：项目记忆的列表浏览与向量检索结果展示。

明确的非目标：不复刻 agent 自动写入/检索记忆的工作流（那是程序高频自动调用的），不做面向终端用户的产品形态。

## 2. 技术栈与定位

- React 18 + TypeScript + Vite
- Ant Design 5（企业级中后台组件库，承载「生产系统样式」）
- React Router（路由与受保护路由）
- Axios（请求封装与拦截器）
- Vitest + React Testing Library（与后端测试框架一致）

约束：**后端零改动**。前端纯静态 SPA，开发期通过 Vite 代理连后端，部署期构建为静态文件由任意静态服务器托管。

## 3. 项目位置与构建

代码放在仓库 `web/` 子目录，与后端 `src/` 同仓库、独立构建：

```
web/
├── src/
│   ├── api/          # axios 实例（注入 JWT）+ 各模块接口封装
│   ├── components/   # 布局（左侧菜单 + 顶部 Header）、受保护路由
│   ├── pages/        # login / users / groups / model-config / memory
│   ├── store/        # 登录态（token + 用户信息），localStorage 持久化
│   └── types/        # 与后端对齐的 TS 类型
├── vite.config.ts    # dev 代理 /api → http://localhost:8787
├── tsconfig.json
└── package.json
```

- 开发：`vite` 启动 dev server，`/api` 代理到 `:8787`。
- 部署：`vite build` 产出静态文件，独立托管（不进后端进程）。

## 4. 后端响应契约（已核实源码）

统一信封 `src/reply.ts`：

```ts
interface Envelope<T> { code: number; msg: string; data: T }
// 成功：code === 0；失败：code 为非零业务码，data 为 null
```

前端 axios 响应拦截器统一处理：
- HTTP 200 且 `code === 0` → 返回 `data`。
- `code !== 0` → 用 message 弹出 `msg`，并 reject。
- HTTP 401 / token 失效 → 清除登录态，跳转登录页。
- 网络错误 → 统一兜底提示。

## 5. 页面与接口映射（已核实源码）

| 页面 | 功能 | 接口 | 权限 |
|---|---|---|---|
| 登录 | 用户名密码登录，存 token + user | `POST /api/auth/login` | 公开 |
| 用户管理 | 列表、新建、改分组、启用/禁用 | `GET/POST /api/admin/users`、`PATCH /api/admin/users/:id` | admin |
| 分组管理 | 列表、新建 | `GET/POST /api/admin/groups` | admin |
| 模型配置 | 查看、修改（凭证脱敏） | `GET /api/model-config`、`PUT /api/admin/model-config` | 读：登录用户 / 改：admin |
| 记忆查看 | 列表、向量检索、删除 | `GET/POST /api/project-memory`、`POST /api/project-memory/search`、`DELETE /api/project-memory/:id` | 登录用户（组隔离） |

### 关键接口细节（影响前端实现）

- **登录** 返回 `{ token, user: { id, username, role, groupId } }`，token 有效期 7 天。前端据 `role` 做菜单级权限隐藏，据 `groupId` 判断记忆功能可用性。
- **新建用户** 入参 `{ username, password, role?, groupId? }`，role 默认 `member`；用户名重复返回 `code 1022`。
- **改用户** PATCH 入参 `{ groupId?, disabled? }`，按字段存在与否分别更新。
- **模型配置 GET** 永不下发凭证明文，只返回 `{ baseUrl, modelName, allowLocalOverride, hasCredential }`。前端用 `hasCredential` 展示「已配置/未配置」，不试图回显凭证。
- **模型配置 PUT** 入参 `{ baseUrl, modelName, credential?, allowLocalOverride }`；`credential` 为空时后端保留原值（COALESCE），前端「不修改凭证」时不要传该字段。
- **记忆接口** 均要求用户有 `groupId`，否则返回 `code 1010「当前用户未分配分组」`。前端对无分组用户在记忆页给出友好引导而非报错弹窗。
- **记忆列表** 支持 `limit`（上界 200）、`offset` 分页；**检索** 入参 `{ query, topK? }`，topK 默认 5，返回带相似度的命中结果。

## 6. 视觉规范（企业级生产系统）

- **布局**：经典控制台——左侧深色可折叠菜单（Logo + 四大模块）+ 顶部 Header（面包屑 + 当前用户名 + 退出）+ 内容区白底卡片。
- **配色**：Ant Design 默认蓝主色 `#1677ff`，中性灰背景，克制不花哨。
- **组件统一**：Table（分页/加载态/空态）、Form（校验）、Modal（新建/编辑）、message（操作反馈）、Popconfirm（危险操作二次确认）。
- **敏感数据**：凭证字段用 Password 输入框，不回显真实值；只展示「已配置/未配置」状态。
- **反馈**：全局 loading 与错误提示统一走拦截器；删除、禁用等危险操作二次确认。

## 7. 状态与鉴权

- 登录态（token + user）存于内存 store 并持久化到 localStorage，刷新后恢复。
- Axios 请求拦截器自动注入 `Authorization: Bearer <token>`。
- 受保护路由组件：未登录跳登录页；菜单按 `role` 渲染（前端隐藏仅为体验，真正的权限关卡在后端 `requireAdmin`）。

## 8. 错误处理

- 401 → 清登录态并跳登录页。
- 业务 `code !== 0` → message 弹 `msg`。
- 网络/超时 → 统一兜底提示。
- 记忆 `code 1010`（无分组）→ 页面内友好引导，提示联系管理员分配分组。

## 9. 测试策略

- 框架：Vitest + React Testing Library（与后端一致）。
- 覆盖：登录态管理、api 封装与响应拦截器逻辑、受保护路由跳转、权限菜单渲染。
- 组件交互：登录流程、用户新建、记忆检索等核心路径做冒烟测试。

## 10. 风险与注意

- 后端无 CORS 配置：开发期靠 Vite 代理规避；生产期需同源部署或后端另加 CORS（属后端改动，超出本期范围，部署时再评估）。
- 凭证安全：前端永不持有/回显模型凭证明文，符合后端「不明文下发」设计。
