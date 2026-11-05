# echo-agent-server

Echo Agent 企业组织记忆服务端。仓库包含 Fastify API、SQLite 数据与向量索引、异步文档摄取、Agentic RAG、模型代理、MCP、Skill 分发、审计/质量管理，以及 `web/` 下的 React 管理后台。

## 能力边界

- 文档：Markdown/TXT、PDF、DOCX、PPTX、XLSX、图片、音频和视频。
- 检索：权限过滤后的 BM25 + 向量召回 + 精排，答案逐条带原文引用。
- 管理：用户、分组、空间、企业策略、文档安全扫描与发布、知识提升、组织记忆、模型配置、质量与审计。
- 接入：JWT API、OpenAI-compatible chat proxy、SSE 知识问答、MCP、增量同步。
- 安全：RBAC、scope/密级过滤、ClamAV 故障关闭、服务端密钥加密、管理后台 HttpOnly refresh cookie、CSP、限流、迁移前备份和周期在线备份。

外部模型属于部署依赖，仓库不会伪造模型结果。配置了 `MiniMax-M3` 聊天模型后，图片理解和扫描 PDF 的逐页识别会复用其多模态接口；音频及视频音轨会复用同一网关的 `asr-1.0` `/v1/speech_to_text` 接口。视频另外抽取最多 24 帧，结合音轨文字建立索引。未配置对应能力时上传会同步返回 503；健康接口会列出 `readinessReasons`。

组织文档上传在技术扫描通过后自动发布并异步建立索引：个人空间由本人上传，团队空间由成员上传，成员可向有权访问的组织空间显式上传，历史待处理记录会自动重新扫描。提交者可查看和下载自己的原件，也可移除自己的提交；移除已发布文档会立即归档并清除检索索引，原始文件字节保留在持久化存储中。客户端文件夹上传逐个提交支持的文件，并以相对路径作为文档标题。

## Agentic RAG 问答闭环

`POST /api/v1/knowledge/ask` 的 `auto` / `deep` 模式使用受约束的 Agentic 工作流：模型先以 JSON 规划必要事实和子查询，服务端在权限范围内执行混合检索；证据审查器发现缺口后最多补检 3 轮、总计 8 个查询。跨查询结果再次用 RRF 融合，并受全局文档多样性和 10k token 证据预算约束。显式 `fast` 保持单轮低延迟路径。

答案由原子 claim 组成。每条 claim 必须绑定原文引用，并依次通过本地数字/单位/条件/否定硬校验和模型语义蕴含校验；验证器还会检查全部必要事实是否完整覆盖。一次受约束修复仍失败时返回原文抽取，不返回未经验证的生成结论。模型规划、审查或 JSON 输出不可用时会降级到确定性规则，权限过滤与拒答边界保持不变。

## 本地启动

要求 Node.js 22；处理视频或超过 20MB 的音频还需系统安装 `ffmpeg`。

```bash
cp .env.example .env
# 在 .env 中取消注释并填写 JWT、主密钥、管理员密码及模型端点
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
| `ECHO_EMBED_MODEL/DIM/URL` | 模型默认 `embed-pro`、1024 维；项目环境模板配置 `http://123.56.188.16:8088/v1/embeddings`，无需 Key。未配 URL 时仅有开发用 hash 降级。 |
| `ECHO_RERANK_MODEL/URL` | 模型默认 `rerank-pro`；项目环境模板配置 `http://123.56.188.16:8088/v1/rerank`，无需 Key。未配 URL 时仅有词汇分数降级。 |
| `ECHO_OCR_URL/KEY` | 可选的独立 OCR multipart 接口；未配置时复用已配置的 M3 图片理解。 |
| `ECHO_VLM_URL/KEY/MODEL` | 可选的独立图片 caption multipart 接口；未配置时复用已配置的 M3 聊天网关。 |
| `ECHO_TRANSCRIBE_URL/KEY/MODEL` | 可选的独立转写接口。未配置时复用已配置的 M3 网关 `/speech_to_text`，模型使用 `asr-1.0`；显式配置仍支持 OpenAI `/audio/transcriptions`。 |
| `ECHO_REQUIRE_CHAT/OCR/VLM/TRANSCRIPTION` | 指定生产就绪必须具备的能力。聊天默认必须，其余默认可选。 |
| `ECHO_AGENTIC_MAX_ROUNDS/QUERIES/REASONING_TIMEOUT_MS/GENERATION_TIMEOUT_MS` | Agentic 检索最大轮次、总查询数、规划/审查与答案生成超时；默认 `3/8/15000/60000`。 |
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

Compose 从当前目录的 `.env` 读取完整服务端配置；`.env.production` 仅提供 Compose 变量（域名、端口、镜像源等）。`.env` 中的 JWT、主密钥、管理员密码及需鉴权的模型 Key 应保持注释，由 `deploy/secrets/` 提供；直接填写的值会优先于 secret 文件。更新服务时应同步完整的 `.env` 文件并重新创建容器。

```bash
cp .env.example .env
cp .env.production.example .env.production
# 配置 .env 中的模型端点，并替换 .env.production 中的部署地址
ECHO_BOOTSTRAP_ADMIN_PASSWORD='使用强密码' \
ECHO_CHAT_KEY='...' \
  ./deploy/init-secrets.sh
docker compose --env-file .env.production up -d --build
```

生产镜像内置 ffmpeg。Compose 默认要求聊天、真实嵌入、精排、OCR、VLM、音视频转写和 ClamAV 均可用；M3 网关可同时提供前三项多模态能力，无需另配独立 URL。健康检查只验证配置和本地依赖，部署后仍应以实际图片、扫描 PDF、音频和视频上传验证上游接口。备份写入可持久化的 `echo_backups` 命名卷，数据库迁移前还会额外自动创建快照；正式灾备应再把该卷定期同步到异机或对象存储。

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

## 组织知识与模型服务管理控制台

管理端采用与 EchoAgent 桌面端一致的浅色侧栏、薄荷绿强调色和统一表单布局。
Web 后台仅限管理员登录，用于服务配置、成员管理、安全检查和全组织用量治理。
知识维护人和成员通过 Echo Agent 桌面端使用服务，不可登录此后台；既有客户端
认证、知识提交、配置同步与模型代理接口继续保留。此版本不包含企业身份接入。

管理端不提供“我的提交”和个人通知页；自动检查与异常集中在概览，发布和拦截结果保留在安全检查
记录中，质量分析与维护任务合并在“知识质量”。用户密钥须明确选择所属用户。
后台使用独立的 `/api/v1/admin/auth/*` 登录、续期、登出与身份校验接口及 HttpOnly
Cookie，服务端实时核验管理员角色；旧后台路径会引导到对应管理页面。

- **知识管理**：逻辑文档与版本历史、原文预览、元数据维护、新版本上传、手动切换
  已就绪版本、批量上传/重建/下线、按服务器实际能力限制上传格式；经验分页、证据、
  可信状态、有效期、变更历史与矛盾裁决；技能版本、扫描报告、文件预览、分发策略、
  回退与停用。异步检查和撤回使用数据库租约，防止重复发布。
- **模型服务**：保存并热加载上游配置，实际连接测试，配置历史恢复；下发服务器
  Base URL 和独立用户/设备密钥，支持撤销及多密钥按用户汇总。真实上游 Key 不再
  下发。访问密钥仅能调用模型网关，不能访问知识或管理接口。
- **用量治理**：用户排名、部门历史归属、场景/模型分布、每日趋势、调用明细、CSV
  导出；组织/部门/用户/密钥的日、月、滚动窗口配额，以及 RPM、并发与费用控制。
  空限额表示不限，0 表示禁止；提醒和拦截可分别配置。
- **知识运营**：自动安全检查、管理概览待办、质量维护任务、复测关闭、贡献与实际引用统计、
  处理任务重试、客户端联系/安装回执、可筛选分页审计、运行能力与完整备份。

### 客户端与上游配置

在「模型配置」保存上游 Base URL、模型和真实密钥，并执行连接测试。
客户端地址默认使用当前请求的服务器地址；通过代理或域名部署时，在「网关与计价」
显式设置对外地址，例如：

```text
https://10.132.19.82:8787/api/v1/llm/v1
```

桌面端继续调用登录后的 `GET /api/v1/client/model-config`，响应字段保持
`chatProvider / chatModel / chatBaseUrl / chatKey`；其中 URL 和 Key 现在属于服务器网关。
同一用户设备复用自己的有效密钥，撤销后重新同步会生成新密钥。手动创建的密钥只在
创建响应中展示明文。密钥由安全随机数生成，格式为 **32 位大写十六进制**；不使用
可由用户名推算的 MD5。数据库同时保存查询摘要和用于设备重同步的加密密文。
停用账号、重置密码、撤销全部会话或对应设备会使相关凭证失效，历史账本保留。

兼容入口如下；除 Chat 外需在管理端明确启用，上游也必须支持对应协议：

| 能力 | 服务器路径（相对 Base URL） |
| --- | --- |
| 对话 / 工具调用 / SSE | `/chat/completions` |
| 模型列表 | `/models` |
| Responses | `/responses` |
| Anthropic Messages | `/messages` |
| 图像生成 | `/images/generations` |
| 语音合成 | `/audio/speech` |
| 音频转写（multipart） | `/audio/transcriptions` |

图像、合成语音、转写可分别配置模型名。客户端不能覆盖管理员指定的模型，文本请求
受单次输出上限控制。归纳、回答、嵌入、精排、OCR、图像理解和文档处理中的真实上游
调用也进入同一账本；重试按真实调用次数记录，外层工作流不重复计量。

融合 `minimax.zip` 的兼容转发、流式 usage 观察、滚动配额和幂等入账思路，沿用
当前 Fastify、SQLite 与账号体系。未导入压缩包中的虚拟环境、运行数据库、日志、
环境文件或 Git 历史；不将厂商自定义的多模态“等效 Token”混入实际 Token 排名。
当前入口按上游兼容协议调用，不代理任意 URL 或任意厂商原生路径。

### 统计与配额口径

- 实际总量为规范化输入和输出；缓存读取/写入、推理量单独保留，避免重复加总。
  OpenAI 缓存读取包含在输入内；Anthropic 将未缓存输入与缓存字段归一后计入输入。
- 未返回用量是 `unknown`，中断或不完整字段是 `partial`；不以 0 代替。流式请求
  要求最终 usage。费用按调用时的价格快照估算，多币种分别展示；缺价显示未知，
  缓存写入没有独立价格时不生成失真的费用估算。
- 配额在 SQLite 事务内预留，返回后按实际量结算；未知调用保留预留并可由管理员
  根据上游记录核对。预留为估算，**不承诺供应商账单绝不超限**；实际消耗即使超出
  预留也完整保留。费用规则要求价格可计算、币种一致，历史未定价调用需先核对。
- 日/月周期按北京时间；调用按开始时间归属。部门名称和用户标识在调用时快照，
  后续调岗、改名或轮换密钥不改写历史。排名只使用实际量，未结算数另列。
- 不在账本保存完整提示词和回答。知识贡献、引用和反馈与 Token 消耗分开展示；
  同一回答对同一逻辑文档的多个片段只计一次引用。未反馈不算满意。

### 客户端状态与策略

旧桌面端可直接使用网关配置与用量统计。可选的
`POST /api/v1/client/heartbeat` 接收版本、平台、设备名称、策略版本、模型配置版本和
技能安装/移除/失败回执。设备 ID 绑定当前登录会话，不能冒充另一台设备。
没有心跳或安装回执的旧客户端明确显示“未上报/未确认”；配置下载不视为安装成功。
离线客户端的撤销、技能和策略变化在重新连接或租约到期后应用。策略历史恢复会签发
更高版本，保留客户端防回退规则。

### 完整备份与恢复

「运行与备份」下载数据库与原始资产的完整 ZIP，含逐文件 SHA-256 清单；生成和恢复
均检查数据库引用的资产是否齐全。恢复工具检查文件哈希、SQLite 完整性与安全路径，
只写入**新的空目录**，不会覆盖现有部署。

```bash
npm run backup:restore -- /absolute/echo-backup.zip /absolute/new-restore --verify-only
npm run backup:restore -- /absolute/echo-backup.zip /absolute/new-restore
```

停服后将 `ECHO_DB_PATH` 指向新目录的 `echo.db`，将 `ECHO_STORAGE_DIR` 指向新目录的
`storage`。原部署的 `ECHO_MASTER_KEY`、JWT 密钥、环境服务地址及外部服务配置需
另行保留；更换主密钥会使原加密凭证和签名身份不可恢复。原有定时数据库备份继续
保留，完整 ZIP 用于包含原始文件和技能包的恢复。

升级前执行备份，在服务器运行 `npm run build:all` 后沿用现有 `./restart.sh` 或
Docker Compose 更新流程。新增迁移 `011_gateway_operations.sql` 为增量迁移，保留
现有用户、知识与版本标识；服务启动前仍会为已有数据库创建迁移前快照。

切换网关后，应让已登录的桌面端重新登录或重新启动以同步新配置；此前直连上游的
历史请求不能补做可靠的逐用户归因。旧版本曾下发真实上游密钥，因此完成客户端
切换后应在供应商端轮换旧密钥，并在服务器保存新密钥，使已缓存的旧凭证失效。


### 自动安全检查与发布

共享发布无需人工审批。成员显式选择自己有权访问的团队或组织空间后，文档通过病毒和主动内容检查即可入库，技能通过包结构、路径、病毒、危险命令和疑似凭证检查后自动签名发布。个人内容不会自动共享；客户端执行权限继续生效。组织经验经过文本安全检查后以“成员提供（reported）”入库，不标记为人工复核或事实验证。

“安全检查”提供文档、技能和经验的检查记录、引擎报告、拦截原因及重新检查操作。检查不通过的内容保持隔离；必需的病毒引擎不可用时不会发布，后台自动重试。新版本会重新扫描历史待处理记录，恢复未完成的自动发布，已停用技能及失去权限的提交不会被重新启用。文件入库后的解析、索引状态仍在“处理任务”中查看。

迁移 `012_automatic_publication.sql` 保留历史数据与客户端接口；响应中的 `approved` 兼容既有客户端，表示已通过发布流程，不代表人工审批。旧 `/review` 页面跳转到安全检查，管理端不再提供人工通过、退回按钮。危险特征的静态检查不能覆盖所有行为，技能运行继续遵守桌面端授权。


### 管理工作流与状态口径

组织文档的“可检索”同时包含完整索引、部分语义索引和仅关键词三种情况。知识工作区列表返回 `chunkCount` 与 `vectorChunkCount`；`keywordOnly` 筛选及 `documentKeywordOnly` 只统计全文索引就绪且完全没有向量的降级文档，`semanticPartial` 筛选及 `documentSemanticPartial` 统计仍有部分向量的降级文档。两类互不重叠，并遵守授权范围、密级和当前文档版本限制。重建完成后，文档仍可检索，对应降级统计归零。

管理端按「概览、知识资产、成员与设备、模型服务、系统管理」五个一级入口组织。
成员详情集中呈现共享知识权限、接入指引、用量、适用配额、密钥及设备；个人知识不在后台展示。
`/search` 兼容跳转到质量改进中的检索验证；既有 API 路径继续兼容。

- 安全检查失败且已阻止发布的内容默认列为已隔离，不作为永久待办。管理员可记录待跟进、确认隔离或归档；这些操作从不改变扫描结论或放行内容。检查服务故障及超时队列另列为需恢复异常。
- 维护清单仅分派给启用的管理员。关联知识通过名称搜索，排除私人空间和超出密级的内容。检索复测记录真实命中结果；人工复测明确保留依据。复测通过须有可用的关联知识和验证记录，关闭须先保存复测通过。重复问题复用未关闭事项；误报或不适用的问题可记录「无需维护」，不会冒充复测成功。
- 模型配置先保存上游再进行真实连接验证。验证结果绑定配置版本，配置变更后的旧验证不会作为当前成功状态。引擎已配置与上游实际可用分别呈现。
- Token 排名只纳入已知实际用量，同一成员改名后仍合并统计。未知量显示待核对，不计作零消耗；趋势不为只有未知量的日期绘制零值。界面展示账本统计起点与结算覆盖率。
- 知识质量显示实际样本量与反馈覆盖情况；无反馈时不展示零负反馈率作为质量结论。Token 消耗与知识贡献分开呈现。
- 新版桌面端按服务器声明的协议每 60 秒上报心跳；模型应用和技能安装/移除/失败回执来自本地实际提交结果。部分回执明确标识，未上报的旧客户端不视为离线或已应用。现有安装版需要更新客户端才能增加这些回执。
- 数据库周期快照与包含原始资产的完整备份分别展示。完整备份生成记录不等同于已异地保存或已完成恢复演练。
- 管理端入口 HTML 不缓存；不存在的静态资源返回真实 404。页面分块加载失败时提供刷新恢复入口。

## 许可证

本项目原创代码采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，允许许可证规定的非商业用途。超出许可范围的商业用途需事先取得另行授权，请联系仓库维护者。

第三方组件保留各自的许可证。此前已按其他许可证授予的权利不受本次更新影响。
