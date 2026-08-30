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
| `ECHO_COOKIE_SECURE` | HTTPS 部署保持默认 `true`；纯 HTTP 内网入口必须显式设为 `false`，否则刷新 cookie 会被浏览器丢弃。 |
| `ECHO_TRUST_PROXY_HOPS` | Fastify 前可信反向代理层数；直连为 `0`，单层 Nginx/Caddy 为 `1`。不要填写不受控的代理层数。 |
| `ECHO_DEBIAN_MIRROR` | Dockerfile 构建参数；受限网络下替换 Debian 源地址，例如 `http://mirrors.aliyun.com/debian`。 |
| `ECHO_DISABLE_LOGIN_THROTTLE` | 仅 `eval`/CI 用，设为 `1` 关闭登录限流；生产保持默认关闭。 |
| `ECHO_ACCESS_TTL` / `ECHO_REFRESH_TTL_MS` | access token 有效期（默认 `1h`）与 refresh token 有效期（默认 30 天）。 |

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

如果是不出公网的纯 HTTP 内网部署（不要 Caddy 反代、不做 TLS），用 `deploy/docker-compose.direct.yml` 作为 overlay：

```bash
ECHO_PUBLIC_PORT=8787 \
ECHO_DEBIAN_MIRROR='http://mirrors.aliyun.com/debian' \
docker compose --env-file .env.production \
  -f docker-compose.yml -f deploy/docker-compose.direct.yml \
  up -d --build
```

该 overlay 会显式设置 `ECHO_COOKIE_SECURE=false` 并把服务端直接以 HTTP 暴露在 `ECHO_PUBLIC_PORT`（默认 8787）。**纯 HTTP 模式必须同步关闭 secure cookie**，否则浏览器不会回写 refresh token，管理后台每次重启会话都会失效；CSP 的 `upgrade-insecure-requests` 在直连模式下也会被服务端关掉，避免同源脚本被改写成 HTTPS 请求导致白屏。

### 主机 Nginx + IP 地址 HTTPS

内网没有域名时，可使用私有 CA 签发包含 IP SAN 的证书，让主机 Nginx 在 `8787` 终止 TLS，容器只暴露到回环地址：

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f deploy/docker-compose.nginx.yml \
  up -d --build
sudo install -m 0644 deploy/nginx-echo-agent-server.conf \
  /etc/nginx/sites-available/echo-agent-server-https
sudo ln -s /etc/nginx/sites-available/echo-agent-server-https \
  /etc/nginx/sites-enabled/echo-agent-server-https
sudo nginx -t && sudo systemctl reload nginx
```

证书放在 `/etc/nginx/ssl/echo-agent-server/server.crt`，私钥放在同目录的 `server.key`。证书必须包含实际服务器 IP 的 `subjectAltName`；每台浏览器所在设备需信任签发它的私有 CA。Echo Agent Desktop 可将该 CA 作为 PEM 编译进组织服务专用 HTTP 客户端，信任范围不会扩展到其他请求。

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
