# echo-agent-server

Echo Agent 企业版的项目记忆服务：账号/分组/JWT、项目记忆向量检索（组隔离）、模型配置下发。

## 启动
1. 复制 `.env.example` 为 `.env`，设置 `ECHO_SERVER_SECRET`（>=32 字节）与初始管理员。
2. `npm install && npm run dev`（开发）或 `npm run build && npm start`（生产）。
3. 首启自动用 `ECHO_ADMIN_USER/PASSWORD` 创建超级管理员。

## 向量检索
默认使用确定性 hash 向量（零依赖，可离线）。配置 `ECHO_EMBED_URL/KEY/MODEL`（OpenAI 兼容 `/embeddings`）后切换为真实 embedding。

## 管理后台前端
`web/` 目录是 React + Ant Design 管理后台。开发：`cd web && npm install && npm run dev`（需后端先在 :8787 运行）。详见 `web/README.md`。
