# echo-agent-server

Echo Agent 企业组织记忆服务端。仓库包含 Fastify API、SQLite 数据与向量索引、异步文档摄取、Agentic RAG、模型代理、MCP、Skill 分发、审计/质量管理，以及 `web/` 下的 React 管理后台。

## 能力边界

- 文档：Markdown/TXT、PDF、DOCX、PPTX、XLSX、图片、音频和视频。
- 检索：权限过滤后的 BM25 + 向量召回 + 精排，答案逐条带原文引用。
- 管理：用户、分组、空间、企业策略、文档审核、知识提升、组织记忆、模型配置、质量与审计。
- 接入：JWT API、OpenAI-compatible chat proxy、SSE 知识问答、MCP、增量同步。
- 安全：RBAC、scope/密级过滤、ClamAV 故障关闭、服务端密钥加密、管理后台 HttpOnly refresh cookie、CSP、限流、迁移前备份和周期在线备份。

外部模型属于部署依赖，仓库不会伪造模型结果：未配置图片理解或音视频转写时，相应上传会同步返回 503；未配置 OCR 的扫描 PDF 会明确摄取失败；健康接口会列出准确的 `readinessReasons`。

## 本地启动

要求 Node.js 22；处理视频或超过 20MB 的音频还需系统安装 `ffmpeg`。

```bash
cp .env.example .env
# 修改 JWT、主密钥、管理员密码及模型端点
npm install
npm --prefix web install
npm run dev
```

生产式本机启动可使用 `./start.sh`。脚本每次都会构建服务端与管理后台，避免代码更新后继续运行旧的 `dist`。`./restart.sh` 会先构建并校验配置，成功后才停止旧进程。

首次空库必须设置 `ECHO_ADMIN_PASSWORD`（至少 8 位），系统不会创建默认弱密码。

## 关键配置

| 配置 | 用途 |
|---|---|
| `ECHO_JWT_SECRET` / `ECHO_MASTER_KEY` | JWT 签名与服务端凭据加密；必填。 |
| `ECHO_CHAT_MODEL/BASE_URL/KEY` | 新部署的聊天模型；后台数据库配置优先于环境变量。 |
| `ECHO_EMBED_URL/KEY` | OpenAI-compatible `/embeddings`；未配时仅有开发用 hash 降级。 |
| `ECHO_RERANK_URL/KEY` | 精排接口；未配时仅有词汇分数降级。 |
| `ECHO_OCR_URL/KEY` | 扫描 PDF OCR multipart 接口。 |
| `ECHO_VLM_URL/KEY/MODEL` | 图片 caption multipart 接口与实际模型名。 |
| `ECHO_TRANSCRIBE_URL/KEY/MODEL` | 完整的 OpenAI-compatible `/audio/transcriptions` 地址。 |
| `ECHO_REQUIRE_CHAT/OCR/VLM/TRANSCRIPTION` | 指定生产就绪必须具备的能力。聊天默认必须，其余默认可选。 |
| `ECHO_ANTIVIRUS_*` | ClamAV 地址、超时及是否故障关闭。 |
| `ECHO_BACKUP_DIR/INTERVAL_HOURS/RETENTION` | SQLite 在线备份目录、周期和保留份数。 |
| `ECHO_CORS_ORIGINS` | 跨域白名单；留空只允许同源。 |

所有 `*KEY`、JWT、主密钥和管理员密码均支持对应的 `*_FILE`，用于 Docker/Kubernetes secrets。完整字段见 [.env.example](.env.example) 与 [.env.production.example](.env.production.example)。

## Docker 生产部署

```bash
cp .env.production.example .env.production
# 替换域名和所有 example.com 模型端点
ECHO_BOOTSTRAP_ADMIN_PASSWORD='使用强密码' \
ECHO_CHAT_KEY='...' ECHO_EMBED_KEY='...' ECHO_RERANK_KEY='...' \
ECHO_OCR_KEY='...' ECHO_VLM_KEY='...' ECHO_TRANSCRIBE_KEY='...' \
  ./deploy/init-secrets.sh
docker compose --env-file .env.production up -d --build
```

生产镜像内置 ffmpeg。Compose 默认要求聊天、真实嵌入、精排、OCR、VLM、音视频转写和 ClamAV 均配置完成；未满足时服务仍会输出诊断，但不会被标记为 production-ready，Caddy 也不会提前接流量。备份写入可持久化的 `echo_backups` 命名卷，数据库迁移前还会额外自动创建快照；正式灾备应再把该卷定期同步到异机或对象存储。

## 验证

```bash
npm test
npm run build
npm --prefix web test -- --run
npm --prefix web run build
npm run eval:ci
```

黄金评估集位于 `eval/dataset.jsonl`，CI 会执行权限泄漏、召回率、精确率、忠实度、相关性、拒答率和延迟阈值门禁，并上传 `eval/reports/` 报告。

健康检查为 `GET /api/v1/health`。`models.productionReady` 表示部署要求均满足；`models.readinessReasons` 给出缺失能力，`models.chat.source` 会说明聊天配置来自数据库还是环境变量。
