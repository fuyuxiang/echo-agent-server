# echo-agent-server

Echo Agent 企业版组织记忆中枢：账号/分组/JWT、文档摄取与混合检索、知识提升审核、组织记忆、增量同步、MCP、模型配置下发、质量看板与审计。

## 启动

1. 复制 `.env.example` 为 `.env`，按需调整下列变量（详见 `.env.example`）。
2. `npm install && npm run dev`（开发）或 `npm run build && npm start`（生产）。
3. 首启会要求 `ECHO_ADMIN_PASSWORD`（>= 8 位），并用 `ECHO_ADMIN_USER/PASSWORD` 创建超级管理员。

## 关键环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ECHO_JWT_SECRET` | 是 | 至少 32 字符，用于签发与校验 JWT。 |
| `ECHO_MASTER_KEY` | 是 | 任意长度字符串，会做 SHA-256 派生为 32 字节 AES 主密钥，用于加密模型 API Key。 |
| `ECHO_DB_PATH` | 否 | SQLite 路径，默认 `./data/echo.db`。 |
| `ECHO_STORAGE_DIR` | 否 | 原始文件存储路径，默认 `./data/storage`。 |
| `ECHO_MODEL_DIR` | 否 | ONNX 模型目录。 |
| `ECHO_PORT` / `ECHO_HOST` | 否 | 默认 `8787` / `0.0.0.0`。 |
| `ECHO_EMBED_URL` / `ECHO_EMBED_KEY` / `ECHO_EMBED_MODEL` | 否 | 远端 OpenAI 兼容 embedding；不配则用 hash 占位实现。 |
| `ECHO_RERANK_URL` / `ECHO_RERANK_KEY` / `ECHO_RERANK_MODEL` | 否 | 远端 cross-encoder 精排；不配则用词汇重叠打分占位。 |
| `ECHO_CORS_ORIGINS` | 否 | 逗号分隔 origin 白名单。留空则拒绝跨域（仅允许同源）。 |
| `ECHO_RATE_LIMIT_RETRIEVE` | 否 | 每用户 `/api/v1/retrieve` 限流（次/分钟），默认 60。 |
| `ECHO_RATE_LIMIT_LLM` | 否 | `/api/v1/llm/chat` 限流，默认 20。 |
| `ECHO_RATE_LIMIT_LOGIN` | 否 | `/api/v1/auth/login` 限流，默认 5。 |

## 检索

默认使用确定性 hash 向量（零依赖、可离线）。配置 `ECHO_EMBED_URL/KEY/MODEL`（OpenAI 兼容 `/embeddings`）后切换为真实 embedding。`/api/health` 暴露 `models.productionReady`，为 false 表示生产环境能力未就绪。

## 质量门禁

- `npm test` — 单元/集成测试（Node 环境，165+ 用例）。
- `cd web && npm test -- --run` — 管理后台浏览器测试（jsdom，23 用例）。
- `npm run eval` — 待补齐（首期黄金评估集 50 条 + 阈值阻断；见路线图阶段 2）。

## 管理后台前端

`web/` 目录是 React + Ant Design 管理后台。开发：`cd web && npm install && npm run dev`（需后端先在 :8787 运行）。详见 `web/README.md`。
