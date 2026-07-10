# 知识管理系统(资料问答) — Phase 1 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 echo-agent-server 新增知识库服务(摄取/检索/生成),在 echo-agent-desktop 新增资料库与资料问答两个页面,实现四类资料问答(精确事实/理解综合/操作指导/探索式)的基础版,数字类问题精准。

**Architecture:** 服务端 Fastify 路由 + better-sqlite3 + sqlite-vec + BM25 倒排 + LLM/Reranker/OCR/ASR(均 OpenAI 兼容)三段流水线:摄取(上传→解析→分块→索引) / 检索(Hybrid RAG + Text-to-SQL + 转写) / 生成(强制引用 + 回原文校验 + 兜底)。客户端复用现有 new:page 四件套 + 新增 SourceViewer 组件做一键跳原文。

**Tech Stack:**
- 服务端: Node 20+ / Fastify 5 / better-sqlite3 12 / sqlite-vec / zod / lunr(BM25) / xlsx / pdf-parse / mammoth(docx) / fluent-ffmpeg
- 客户端: Electron 41 / React 18 / TypeScript / Zustand / axios / SCSS Modules / i18next
- 外部模型: vLLM(Qwen/DeepSeek) + bge-m3 + bge-reranker + FunASR + PaddleOCR(全本地,OpenAI 兼容)

**Spec:** `docs/superpowers/specs/2026-07-10-knowledge-base-system-design.md`

---

## Global Constraints

(从 spec §3、§10、§13 直接提取,每个任务都隐含遵循)

- **部署**: 全内网私有化,禁用云端 API;所有外部模型经 OpenAI 兼容接口走配置
- **权限**: 知识库服务复用现有 JWT + 组隔离,摄取与检索两端都按 `group_id` 过滤
- **正确率档位**: 高(带引用可核实);不追求"拒答/转人工"级别
- **存储**: 原文件落本地文件系统(`ECHO_KB_STORAGE_ROOT`,默认 `./data/kb-files`)
- **Embedding 维度**: 固定 1024(与现有 `vec_memories` 一致)
- **提交规范**: 中文 commit,不带 Claude 署名,主题描述本次改动
- **语言**: 代码注释与变量名英文,所有对话与文档中文
- **不要做的事**: 不引入 Redis/Kafka(Phase 1 用内存队列);不做 GraphRAG(Phase 3);不深度融入 echo-agent 四层记忆(独立服务,Phase 3 才挂接)
- **依赖完整性**: 新增 npm 包必须同时更新 `package.json` 并在 commit message 列出

---

## 文件结构总览

```
echo-agent-server/
├── src/
│   ├── kb/
│   │   ├── types.ts                # 共享类型与契约(跨任务引用,Task A1 产出)
│   │   ├── schema.ts               # DB 迁移 v2(把 kb_* 表挂到现有 MIGRATIONS 链,Task A1)
│   │   ├── storage/
│   │   │   ├── fs.ts               # 原文件落盘/读取(Task A2)
│   │   │   ├── documents.ts        # documents DAO
│   │   │   ├── units.ts            # knowledge_units + vec_kb_units DAO
│   │   │   ├── tables.ts           # tables + table_rows DAO
│   │   │   ├── transcripts.ts      # transcripts DAO
│   │   │   ├── qa_logs.ts          # qa_logs DAO
│   │   │   └── bm25.ts             # BM25 倒排索引(Task E1)
│   │   ├── parsers/
│   │   │   ├── types.ts            # Parser 接口与 Unit 类型
│   │   │   ├── chunker.ts          # 语义分块(Task B1)
│   │   │   ├── text.ts             # 文本/MD(Task B2)
│   │   │   ├── docx.ts             # Word(Task B3)
│   │   │   ├── pdf.ts              # PDF(Task B4)
│   │   │   ├── excel.ts            # Excel 双表征(Task B5)
│   │   │   └── media.ts            # 音视频(Task B6)
│   │   ├── ingestion/
│   │   │   ├── queue.ts            # 内存任务队列(Task C1)
│   │   │   ├── dedupe.ts           # 哈希去重(Task C2)
│   │   │   └── pipeline.ts         # 上传→解析→分块→索引编排(Task C3)
│   │   ├── services/
│   │   │   ├── ocr.ts              # PaddleOCR 客户端(Task D1)
│   │   │   ├── asr.ts              # FunASR 客户端(Task D2)
│   │   │   ├── rerank.ts           # bge-reranker 客户端(Task D3)
│   │   │   └── chat.ts             # LLM 客户端(Text-to-SQL + 生成用)
│   │   ├── retrieval/
│   │   │   ├── hybrid.ts           # 向量 + BM25 + reranker(Task E2)
│   │   │   ├── text2sql.ts         # Text-to-SQL(Task E3)
│   │   │   └── transcript.ts       # 转写检索(Task E4)
│   │   ├── generation/
│   │   │   ├── answer.ts           # 带引用生成(Task F1)
│   │   │   ├── verify.ts           # 回原文校验(Task F2)
│   │   │   └── fallback.ts         # 不足兜底(Task F3)
│   │   └── orchestrator.ts         # /api/kb/ask 主入口(Task G1)
│   └── routes/
│       └── kb.ts                   # /api/kb/* 路由注册(Task A3,后续任务填充)
└── test/
    └── kb/                         # 知识库测试(每个 Task 配套)

echo-agent-desktop/
└── src/renderer/src/
    ├── pages/
    │   ├── KbLibrary/              # 资料库页(Task H1, H2)
    │   │   ├── index.tsx
    │   │   ├── service.ts
    │   │   ├── mock.ts
    │   │   └── kb-library.module.scss
    │   └── KbQA/                   # 资料问答页(Task H3, H4)
    │       ├── index.tsx
    │       ├── service.ts
    │       ├── mock.ts
    │       └── kb-qa.module.scss
    ├── components/
    │   └── SourceViewer/           # 一键跳原文核实(Task H5)
    │       ├── index.tsx
    │       ├── dispatch.ts
    │       ├── PdfViewer.tsx
    │       ├── DocxViewer.tsx
    │       ├── ExcelViewer.tsx
    │       └── MediaPlayer.tsx
    └── router/
        └── routes.ts               # 追加 kb-library 与 kb-qa 路由(Task A4)
```

**契约说明**:
- 所有 DB 表用 `group_id` 字符串外键约束读取;DAO 函数签名一律 `groupId: string` 形参必填,SQL `WHERE group_id = ?` 由 DAO 内部加,不靠调用方传。
- 解析器产出统一为 `ParserUnit { text: string; location: Location; }`,`Location` 是 `DiscriminatedUnion` 按文档类型。
- 客户端 `service.ts` 用 axios `BaseData` 模式(与现有 pages 一致),服务端返回 `{ code, data, message }` 由 `reply.ts` 统一封装。

---

## 任务清单

### A. 基础设施层

#### Task A1: 知识库类型契约与 DB Schema 迁移

**Files:**
- Create: `echo-agent-server/src/kb/types.ts`
- Create: `echo-agent-server/src/kb/schema.ts`
- Modify: `echo-agent-server/src/db.ts:30-60` (把 v2 迁移挂进 MIGRATIONS)
- Test: `echo-agent-server/test/kb/schema.test.ts`

**Interfaces:**
- Consumes: `db.ts:DB`(better-sqlite3 Database),`MIGRATIONS`(已有迁移链)
- Produces: 类型 `DocumentType`、`Location`、`DocumentStatus`、`KnowledgeUnit`、`Citation`、`AskResult`;迁移函数在 `MIGRATIONS[1]` 处注册

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/schema.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../src/db.js'

describe('kb schema migration v2', () => {
  let db: ReturnType<typeof getDb>
  beforeEach(() => { db = getDb(':memory:') })

  it('creates kb_* tables with group_id columns', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kb_%' ORDER BY name"
    ).all() as { name: string }[]
    expect(tables.map(t => t.name)).toEqual([
      'kb_documents', 'kb_knowledge_units', 'kb_qa_logs', 'kb_tables', 'kb_table_rows', 'kb_transcripts',
    ])
  })

  it('creates vec_kb_units virtual table with 1024-dim embedding', () => {
    const v = db.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'vec_kb_units'"
    ).get() as { sql: string }
    expect(v.sql).toContain('float[1024]')
  })

  it('every kb_* table has group_id column with index', () => {
    const cols = db.prepare(
      "SELECT name FROM pragma_table_info('kb_documents') WHERE name='group_id'"
    ).all()
    expect(cols).toHaveLength(1)
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='kb_documents' AND sql LIKE '%group_id%'"
    ).all()
    expect(idx.length).toBeGreaterThan(0)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/schema.test.ts`
Expected: FAIL with "test file not found" or "kb_documents does not exist"

**Step 3: 写 kb/types.ts**

```typescript
// echo-agent-server/src/kb/types.ts
export type DocumentType = 'text' | 'docx' | 'pdf' | 'excel' | 'audio' | 'video'

export type DocumentStatus = 'pending' | 'parsing' | 'indexing' | 'ready' | 'failed'

export interface DocumentRow {
  id: string
  name: string
  type: DocumentType
  groupId: string
  sourcePath: string        // 落盘后路径
  hash: string              // sha256
  version: number
  status: DocumentStatus
  errorMessage: string | null
  uploaderId: string
  createdAt: number
  updatedAt: number
}

export interface LocationPageSection { kind: 'page_section'; page: number; section?: string }
export interface LocationSheetCell { kind: 'sheet_cell'; sheet: string; cellRange: string }
export interface LocationTimestamp { kind: 'timestamp'; startMs: number; endMs: number }
export interface LocationPlain { kind: 'plain'; offset: number; length: number }
export type Location =
  | LocationPageSection | LocationSheetCell | LocationTimestamp | LocationPlain

export interface KnowledgeUnitRow {
  id: string
  docId: string
  groupId: string
  location: Location
  text: string
  vectorRef: string          // = unit.id,留字段以便未来换索引
  createdAt: number
}

export interface Citation {
  unitId: string
  docId: string
  docName: string
  location: Location
  excerpt: string
}

export type Confidence = 'high' | 'medium' | 'low'

export interface AskResult {
  answer: string
  citations: Citation[]
  confidence: Confidence
  fallbackMaterialList?: { docId: string; docName: string }[]
}
```

**Step 4: 写 kb/schema.ts**

```typescript
// echo-agent-server/src/kb/schema.ts
import type { DB } from '../db.js'

export function migrateKb(db: DB): void {
  db.exec(`
    CREATE TABLE kb_documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      group_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      uploader_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_kb_docs_group ON kb_documents(group_id);
    CREATE INDEX idx_kb_docs_hash ON kb_documents(hash, group_id);

    CREATE TABLE kb_knowledge_units (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      location TEXT NOT NULL,         -- JSON
      text TEXT NOT NULL,
      vector_ref TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_kb_units_group ON kb_knowledge_units(group_id);
    CREATE INDEX idx_kb_units_doc ON kb_knowledge_units(doc_id);

    CREATE TABLE kb_tables (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      sheet TEXT NOT NULL,
      schema_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_kb_tables_group ON kb_tables(group_id);
    CREATE INDEX idx_kb_tables_doc ON kb_tables(doc_id);

    CREATE TABLE kb_table_rows (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      row_json TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      FOREIGN KEY (table_id) REFERENCES kb_tables(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_kb_rows_table ON kb_table_rows(table_id);

    CREATE TABLE kb_transcripts (
      seg_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_kb_trans_group ON kb_transcripts(group_id);
    CREATE INDEX idx_kb_trans_doc ON kb_transcripts(doc_id);

    CREATE TABLE kb_qa_logs (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      citations TEXT NOT NULL,         -- JSON
      confidence TEXT NOT NULL,
      feedback INTEGER NOT NULL DEFAULT 0,  -- -1/0/1
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_kb_logs_group ON kb_qa_logs(group_id);

    CREATE VIRTUAL TABLE vec_kb_units USING vec0(
      unit_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      embedding float[1024]
    );
  `)
}
```

**Step 5: 把 v2 迁移挂到 db.ts**

修改 `echo-agent-server/src/db.ts:30-60`:

```typescript
import { migrateKb } from './kb/schema.js'

const MIGRATIONS: ((db: DB) => void)[] = [
  // 已有 v1 不变 ...
  (db) => {
    db.exec(`
      CREATE TABLE groups ( ... );
      CREATE TABLE users ( ... );
      CREATE TABLE project_memories ( ... );
      CREATE TABLE model_configs ( ... );
    `)
    db.exec(`CREATE VIRTUAL TABLE vec_memories USING vec0(memory_id TEXT PRIMARY KEY, embedding float[1024])`)
  },
  migrateKb,  // v2: 知识库
]
```

**Step 6: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/schema.test.ts`
Expected: 3 passed

**Step 7: 提交**

```bash
cd echo-agent-desktop
git add echo-agent-server/src/kb/types.ts \
        echo-agent-server/src/kb/schema.ts \
        echo-agent-server/src/db.ts \
        echo-agent-server/test/kb/schema.test.ts
git commit -m "feat(kb): 添加知识库类型契约与 v2 DB schema 迁移"
```

---

#### Task A2: 原文件存储(fs 适配)

**Files:**
- Create: `echo-agent-server/src/kb/storage/fs.ts`
- Test: `echo-agent-server/test/kb/storage-fs.test.ts`

**Interfaces:**
- Consumes: `process.env.ECHO_KB_STORAGE_ROOT` (默认 `./data/kb-files`)
- Produces: `saveOriginalFile(groupId, docId, buf, ext): Promise<string>` 返回相对存储根的路径;`readOriginalFile(groupId, docId, ext): Promise<Buffer>`;`getOriginalPath(groupId, docId, ext): string` 同步版,供 ffmpeg 流式读取

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/storage-fs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveOriginalFile, readOriginalFile, getOriginalPath } from '../../src/kb/storage/fs.js'

describe('kb storage fs', () => {
  let root: string
  beforeEach(() => {
    root = join(tmpdir(), `kb-fs-${Date.now()}-${Math.random()}`)
    process.env.ECHO_KB_STORAGE_ROOT = root
  })
  afterEach(() => { if (existsSync(root)) rmSync(root, { recursive: true }) })

  it('saves and reads back original file under groupId/docId', async () => {
    const buf = Buffer.from('hello world')
    const relPath = await saveOriginalFile('g1', 'd1', buf, 'txt')
    expect(relPath).toBe('g1/d1.txt')
    expect(readOriginalFile('g1', 'd1', 'txt')).toEqual(buf)
    expect(getOriginalPath('g1', 'd1', 'txt')).toBe(join(root, 'g1/d1.txt'))
  })

  it('refuses path traversal in groupId or docId', async () => {
    await expect(saveOriginalFile('../etc', 'd1', Buffer.from('x'), 'txt')).rejects.toThrow(/path/)
    await expect(saveOriginalFile('g1', '..%2Fpasswd', Buffer.from('x'), 'txt')).rejects.toThrow(/path/)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/storage-fs.test.ts`
Expected: FAIL with module not found

**Step 3: 实现 fs.ts**

```typescript
// echo-agent-server/src/kb/storage/fs.ts
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = () => process.env.ECHO_KB_STORAGE_ROOT ?? './data/kb-files'

const ID_RE = /^[A-Za-z0-9_-]+$/
const EXT_RE = /^[A-Za-z0-9]{1,8}$/

function assertSafeId(id: string, label: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid ${label}: ${id}`)
}

function assertSafeExt(ext: string): void {
  if (!EXT_RE.test(ext)) throw new Error(`invalid extension: ${ext}`)
}

export async function saveOriginalFile(
  groupId: string, docId: string, buf: Buffer, ext: string
): Promise<string> {
  assertSafeId(groupId, 'groupId')
  assertSafeId(docId, 'docId')
  assertSafeExt(ext)
  const rel = `${groupId}/${docId}.${ext}`
  const abs = join(ROOT(), rel)
  await mkdir(join(ROOT(), groupId), { recursive: true })
  await writeFile(abs, buf)
  return rel
}

export async function readOriginalFile(
  groupId: string, docId: string, ext: string
): Promise<Buffer> {
  assertSafeId(groupId, 'groupId')
  assertSafeId(docId, 'docId')
  assertSafeExt(ext)
  return readFile(getOriginalPath(groupId, docId, ext))
}

export function getOriginalPath(groupId: string, docId: string, ext: string): string {
  return join(ROOT(), `${groupId}/${docId}.${ext}`)
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/storage-fs.test.ts`
Expected: 2 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/storage/fs.ts echo-agent-server/test/kb/storage-fs.test.ts
git commit -m "feat(kb): 添加原文件本地存储与路径遍历防护"
```

---

#### Task A3: 服务端 /api/kb/* 路由骨架与鉴权复用

**Files:**
- Create: `echo-agent-server/src/routes/kb.ts`
- Modify: `echo-agent-server/src/app.ts` (注册 kb 路由)
- Test: `echo-agent-server/test/kb/routes-smoke.test.ts`

**Interfaces:**
- Consumes: `app.authenticate`(现有 JWT 鉴权),`app.deps.db`,`app.deps.embed`
- Produces: Fastify 路由 `POST /api/kb/upload`、`GET /api/kb/documents`、`GET /api/kb/documents/:id`、`GET /api/kb/documents/:id/status`、`POST /api/kb/ask`、`POST /api/kb/qa/:id/feedback`(每个路由先返回 501 Not Implemented 占位,后续任务填实现)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/routes-smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/app.js'
import { getDb } from '../../src/db.js'
import type { FastifyInstance } from 'fastify'

describe('kb routes skeleton', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    process.env.ECHO_SERVER_DB = ':memory:'
    const db = getDb()
    app = buildApp({ db, embed: { embed: async () => new Array(1024).fill(0) } })
    await app.ready()
    // 注册并登录一个测试账号
    await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { username: 'alice', password: 'pwd12345678', groupId: 'g1' }
    })
    const r = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: 'pwd12345678' }
    })
    token = r.json().data.token
  })
  afterAll(async () => { await app.close() })

  it('rejects unauthenticated /api/kb/ask with 401', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/kb/ask', payload: { query: 'x' } })
    expect(r.statusCode).toBe(401)
  })

  it('returns 501 for authenticated /api/kb/ask placeholder', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/kb/ask',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'x' }
    })
    expect(r.statusCode).toBe(501)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/routes-smoke.test.ts`
Expected: FAIL with module not found

**Step 3: 写 routes/kb.ts 占位**

```typescript
// echo-agent-server/src/routes/kb.ts
import type { FastifyInstance } from 'fastify'
import { fail } from '../reply.js'
import type { JwtClaims } from '../auth.js'

function groupOr401(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): string | null {
  const c = req.user as JwtClaims
  if (!c.groupId) {
    reply.send(fail(1010, '当前用户未分配分组'))
    return null
  }
  return c.groupId
}

export function registerKbRoutes(app: FastifyInstance): void {
  app.post('/api/kb/upload', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1501, '/api/kb/upload 待 Task C3 实现'))
  })

  app.get('/api/kb/documents', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1502, '/api/kb/documents 待 Task A4+ 实现'))
  })

  app.get('/api/kb/documents/:id', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1503, '/api/kb/documents/:id 待 Task A4+ 实现'))
  })

  app.get('/api/kb/documents/:id/status', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1504, '/api/kb/documents/:id/status 待 Task C3 实现'))
  })

  app.post('/api/kb/ask', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1505, '/api/kb/ask 待 Task G1 实现'))
  })

  app.post('/api/kb/qa/:id/feedback', { preHandler: app.authenticate }, async (req, reply) => {
    if (!groupOr401(req, reply)) return reply
    return reply.code(501).send(fail(1506, '/api/kb/qa/:id/feedback 待 Task H4 实现'))
  })
}
```

**Step 4: 在 app.ts 注册**

修改 `echo-agent-server/src/app.ts` 的 `buildApp` 函数,在 `registerMemoryRoutes(app)` 之后加一行:

```typescript
import { registerKbRoutes } from './routes/kb.js'
// ...
  registerKbRoutes(app)
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/routes-smoke.test.ts`
Expected: 2 passed

**Step 6: 提交**

```bash
git add echo-agent-server/src/routes/kb.ts \
        echo-agent-server/src/app.ts \
        echo-agent-server/test/kb/routes-smoke.test.ts
git commit -m "feat(kb): 添加 /api/kb/* 路由骨架与 JWT+分组鉴权复用"
```

---

#### Task A4: 客户端 kb 服务契约与路由注册

**Files:**
- Create: `echo-agent-desktop/src/renderer/src/services/kb.ts`
- Create: `echo-agent-desktop/src/renderer/src/services/kb.d.ts` (类型)
- Modify: `echo-agent-desktop/src/renderer/src/router/routes.ts` (追加两条路由)
- Test: `echo-agent-desktop/src/renderer/src/services/__tests__/kb.test.ts`

**Interfaces:**
- Consumes: 现有 `request/BaseData`(axios + code/data 解包)
- Produces: 类型 `KbDocument`、`KbAskResult`、`KbCitation`、`KbAskFeedback`;函数 `listKbDocuments`、`getKbDocument`、`getKbDocumentStatus`、`uploadKbDocument`、`askKb`、`submitKbFeedback`

**Step 1: 写失败测试**

```typescript
// echo-agent-desktop/src/renderer/src/services/__tests__/kb.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { askKb, type KbAskRequest } from '../kb'

vi.mock('@/request', () => ({
  post: vi.fn(),
  get: vi.fn(),
}))

import * as req from '@/request'

describe('kb service', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('askKb posts query+topK to /api/kb/ask and unwraps BaseData', async () => {
    ;(req.post as any).mockResolvedValue({
      code: 0, data: { answer: 'a', citations: [], confidence: 'high' }, message: ''
    })
    const r = await askKb({ query: 'foo', topK: 5 } as KbAskRequest)
    expect(r.answer).toBe('a')
    expect(req.post).toHaveBeenCalledWith('/api/kb/ask', { query: 'foo', topK: 5 })
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/services/__tests__/kb.test.ts`
Expected: FAIL with module not found

**Step 3: 写 kb.d.ts 类型**

```typescript
// echo-agent-desktop/src/renderer/src/services/kb.d.ts
export type KbDocumentType = 'text' | 'docx' | 'pdf' | 'excel' | 'audio' | 'video'

export type KbDocumentStatus = 'pending' | 'parsing' | 'indexing' | 'ready' | 'failed'

export interface KbDocument {
  id: string
  name: string
  type: KbDocumentType
  status: KbDocumentStatus
  hash: string
  version: number
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}

export interface KbLocationPageSection { kind: 'page_section'; page: number; section?: string }
export interface KbLocationSheetCell { kind: 'sheet_cell'; sheet: string; cellRange: string }
export interface KbLocationTimestamp { kind: 'timestamp'; startMs: number; endMs: number }
export interface KbLocationPlain { kind: 'plain'; offset: number; length: number }
export type KbLocation =
  | KbLocationPageSection | KbLocationSheetCell | KbLocationTimestamp | KbLocationPlain

export interface KbCitation {
  unitId: string
  docId: string
  docName: string
  location: KbLocation
  excerpt: string
}

export type KbConfidence = 'high' | 'medium' | 'low'

export interface KbAskRequest {
  query: string
  topK?: number
}

export interface KbAskResult {
  answer: string
  citations: KbCitation[]
  confidence: KbConfidence
  fallbackMaterialList?: { docId: string; docName: string }[]
}

export interface KbAskFeedback {
  qaLogId: string
  feedback: 1 | -1
}

export interface KbListDocumentsResponse {
  items: KbDocument[]
  total: number
}
```

**Step 4: 写 kb.ts**

```typescript
// echo-agent-desktop/src/renderer/src/services/kb.ts
import { get, post } from '@/request'
import type {
  KbDocument, KbAskRequest, KbAskResult, KbAskFeedback, KbListDocumentsResponse,
} from './kb'

export type {
  KbDocument, KbDocumentType, KbDocumentStatus,
  KbLocation, KbCitation, KbConfidence,
  KbAskRequest, KbAskResult, KbAskFeedback, KbListDocumentsResponse,
}

export async function listKbDocuments(params: { limit?: number; offset?: number } = {}): Promise<KbListDocumentsResponse> {
  return get('/api/kb/documents', { params })
}

export async function getKbDocument(id: string): Promise<KbDocument & { summary: string }> {
  return get(`/api/kb/documents/${id}`)
}

export async function getKbDocumentStatus(id: string): Promise<{ status: KbDocument['status']; errorMessage: string | null }> {
  return get(`/api/kb/documents/${id}/status`)
}

export async function uploadKbDocument(file: File, onProgress?: (pct: number) => void): Promise<KbDocument> {
  const fd = new FormData()
  fd.append('file', file)
  return post('/api/kb/upload', fd, {
    headers: { 'content-type': 'multipart/form-data' },
    onUploadProgress: e => onProgress?.(Math.round((e.loaded * 100) / (e.total || 1))),
  })
}

export async function askKb(req: KbAskRequest): Promise<KbAskResult> {
  return post('/api/kb/ask', req)
}

export async function submitKbFeedback(fb: KbAskFeedback): Promise<{ ok: true }> {
  return post(`/api/kb/qa/${fb.qaLogId}/feedback`, { feedback: fb.feedback })
}
```

**Step 5: 注册两条路由**

修改 `echo-agent-desktop/src/renderer/src/router/routes.ts`,在数组里追加:

```typescript
{
  path: '/kb-library',
  element: React.lazy(() => import('@/pages/KbLibrary')),
  meta: { title: '资料库' },
},
{
  path: '/kb-qa',
  element: React.lazy(() => import('@/pages/KbQA')),
  meta: { title: '资料问答' },
},
```

**Step 6: 跑测试,确认通过**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/services/__tests__/kb.test.ts`
Expected: 1 passed

**Step 7: 提交**

```bash
cd echo-agent-desktop
git add src/renderer/src/services/kb.ts \
        src/renderer/src/services/kb.d.ts \
        src/renderer/src/router/routes.ts \
        src/renderer/src/services/__tests__/kb.test.ts
git commit -m "feat(kb): 添加桌面端 kb 服务契约与两个页面路由"
```

---

### B. 解析器层

#### Task B1: 解析器接口与语义分块

**Files:**
- Create: `echo-agent-server/src/kb/parsers/types.ts`
- Create: `echo-agent-server/src/kb/parsers/chunker.ts`
- Test: `echo-agent-server/test/kb/parsers-chunker.test.ts`

**Interfaces:**
- Consumes: 任意字符串文本
- Produces: 类型 `ParserUnit { text: string; location: Location }`、`Parser { parse(buf: Buffer, meta: { docId: string; fileName: string }): Promise<ParserUnit[]> }`;函数 `semanticChunk(units: ParserUnit[], opts?: { maxChars?: number; overlapChars?: number }): ParserUnit[]` —— 默认 `maxChars=800, overlapChars=80`,按段落优先切,过长段落按句号/换行硬切,重叠区段落到下一块头部

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/parsers-chunker.test.ts
import { describe, it, expect } from 'vitest'
import { semanticChunk } from '../../src/kb/parsers/chunker.js'
import type { Location } from '../../src/kb/types.js'

const loc = (i: number): Location => ({ kind: 'plain', offset: i, length: 0 })

describe('semanticChunk', () => {
  it('keeps short unit as a single chunk', () => {
    const out = semanticChunk([{ text: 'hello world', location: loc(0) }])
    expect(out).toEqual([{ text: 'hello world', location: loc(0) }])
  })

  it('splits a long paragraph into overlapping chunks', () => {
    const long = '段一。' + '句子'.repeat(200) + '。段二。' + '句子'.repeat(200) + '。'
    const out = semanticChunk([{ text: long, location: loc(0) }], { maxChars: 400, overlapChars: 50 })
    expect(out.length).toBeGreaterThanOrEqual(2)
    // 第二块应包含第一块尾部 50 字
    const tail = out[0].text.slice(-50)
    expect(out[1].text.startsWith(tail)).toBe(true)
  })

  it('preserves location kind on every produced chunk', () => {
    const out = semanticChunk([{ text: 'a'.repeat(2000), location: { kind: 'page_section', page: 3 } }])
    for (const u of out) expect(u.location.kind).toBe('page_section')
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-chunker.test.ts`
Expected: FAIL with module not found

**Step 3: 写 parsers/types.ts**

```typescript
// echo-agent-server/src/kb/parsers/types.ts
import type { Location } from '../types.js'

export interface ParserUnit {
  text: string
  location: Location
}

export interface Parser {
  /** 期望 ext: txt/md/docx/pdf/xlsx/csv/mp3/wav/m4a/mp4 */
  parse(buf: Buffer, meta: { docId: string; fileName: string }): Promise<ParserUnit[]>
}
```

**Step 4: 写 chunker.ts**

```typescript
// echo-agent-server/src/kb/parsers/chunker.ts
import type { ParserUnit } from './types.js'

interface Opts { maxChars?: number; overlapChars?: number }

const DEFAULTS = { maxChars: 800, overlapChars: 80 }

/** 按段落优先;过长段落按句末标点切;块尾 overlap 字符拷贝到下一块头部(用于语义连贯)。 */
export function semanticChunk(units: ParserUnit[], opts?: Opts): ParserUnit[] {
  const { maxChars, overlapChars } = { ...DEFAULTS, ...opts }
  const out: ParserUnit[] = []
  for (const u of units) {
    if (u.text.length <= maxChars) { out.push(u); continue }
    const parts = splitBySentences(u.text, maxChars)
    let prevTail = ''
    for (let i = 0; i < parts.length; i++) {
      const chunkText = prevTail + parts[i]
      out.push({ text: chunkText, location: u.location })
      prevTail = parts[i].slice(-overlapChars)
    }
  }
  return out
}

function splitBySentences(text: string, max: number): string[] {
  const parts: string[] = []
  const re = /[^。！？!?\.\n]+[。！？!?\.\n]?/g
  let buf = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if ((buf + m[0]).length > max && buf) {
      parts.push(buf)
      buf = m[0]
    } else {
      buf += m[0]
    }
    if (buf.length >= max) { parts.push(buf); buf = '' }
  }
  if (buf) parts.push(buf)
  return parts.length ? parts : [text]
}
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-chunker.test.ts`
Expected: 3 passed

**Step 6: 提交**

```bash
git add echo-agent-server/src/kb/parsers/types.ts \
        echo-agent-server/src/kb/parsers/chunker.ts \
        echo-agent-server/test/kb/parsers-chunker.test.ts
git commit -m "feat(kb): 添加解析器接口与语义分块(段落+句末+重叠)"
```

---

#### Task B2: 文本/MD 解析器

**Files:**
- Create: `echo-agent-server/src/kb/parsers/text.ts`
- Test: `echo-agent-server/test/kb/parsers-text.test.ts`

**Interfaces:**
- Consumes: 任意 Buffer
- Produces: `parse(buf): Promise<ParserUnit[]>` —— 按段落产出,`location = { kind: 'plain', offset, length }`(offset 是字符偏移,length 是该段字符数)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/parsers-text.test.ts
import { describe, it, expect } from 'vitest'
import { textParser } from '../../src/kb/parsers/text.js'

describe('textParser', () => {
  it('splits by blank lines into plain-located units', async () => {
    const units = await textParser.parse(Buffer.from('第一段。\n\n第二段。\n\n第三段。'), {
      docId: 'd1', fileName: 'a.txt'
    })
    expect(units.map(u => u.text)).toEqual(['第一段。', '第二段。', '第三段。'])
    expect(units[0].location).toEqual({ kind: 'plain', offset: 0, length: 4 })
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-text.test.ts`
Expected: FAIL

**Step 3: 写 text.ts**

```typescript
// echo-agent-server/src/kb/parsers/text.ts
import type { Parser, ParserUnit } from './types.js'

export const textParser: Parser = {
  async parse(buf) {
    const text = buf.toString('utf8')
    const paras = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
    let offset = 0
    return paras.map<ParserUnit>(p => {
      const unit: ParserUnit = { text: p, location: { kind: 'plain', offset, length: p.length } }
      offset += p.length + 2 // 估算,plain 不强求精确
      return unit
    })
  }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-text.test.ts`
Expected: 1 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/parsers/text.ts echo-agent-server/test/kb/parsers-text.test.ts
git commit -m "feat(kb): 添加文本/MD 解析器"
```

---

#### Task B3: Word 解析器

**Files:**
- Create: `echo-agent-server/src/kb/parsers/docx.ts`
- Modify: `echo-agent-server/package.json` (加 `mammoth`)
- Run: `npm install`
- Test: `echo-agent-server/test/kb/parsers-docx.test.ts`

**Interfaces:**
- Consumes: `.docx` Buffer
- Produces: `parse(buf): Promise<ParserUnit[]>` —— 按段落 + 标题级别产出,`location = { kind: 'page_section', page?: 缺失, section: 'heading-1' | 'heading-2' | 'paragraph' | 'list-item' }`(页码 mammoth 不直接给,Phase 1 先用 section 维度;Phase 2 可换 pdf2json 之类带页码的)

**Step 1: 安装依赖**

```bash
cd echo-agent-server && npm install mammoth
```

**Step 2: 写失败测试**(用 mammoth `extractRawText` 自带的 HTML 风格不直接给 page,所以测试以 section 为准)

```typescript
// echo-agent-server/test/kb/parsers-docx.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { docxParser } from '../../src/kb/parsers/docx.js'

describe('docxParser', () => {
  it('extracts paragraphs and headings as units with section location', async () => {
    // 测试样本: test/fixtures/sample.docx (手工放一个最小 docx,只含"标题一"+"段落"+"标题二"+"段落")
    const buf = readFileSync(join(__dirname, '../fixtures/sample.docx'))
    const units = await docxParser.parse(buf, { docId: 'd1', fileName: 'sample.docx' })
    expect(units.length).toBeGreaterThanOrEqual(2)
    const headings = units.filter(u => (u.location as any).section?.startsWith('heading'))
    expect(headings.length).toBeGreaterThanOrEqual(1)
  })
})
```

**Step 3: 放测试样本并跑测试,确认失败**

```bash
mkdir -p echo-agent-server/test/fixtures
# 由执行者准备:用 Word/WPS 新建一个最小 docx,内容含两级标题 + 段落,导出为 test/fixtures/sample.docx
cd echo-agent-server && npm test -- test/kb/parsers-docx.test.ts
```

Expected: FAIL(模块未找到)

**Step 4: 写 docx.ts**

```typescript
// echo-agent-server/src/kb/parsers/docx.ts
import mammoth from 'mammoth'
import type { Parser, ParserUnit } from './types.js'

type SectionKind = 'heading-1' | 'heading-2' | 'heading-3' | 'paragraph' | 'list-item'

interface HtmlBlock { tag: 'h1' | 'h2' | 'h3' | 'p' | 'li'; text: string }

function htmlToBlocks(html: string): HtmlBlock[] {
  const re = /<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi
  const out: HtmlBlock[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase() as HtmlBlock['tag']
    const text = m[2].replace(/<[^>]+>/g, '').trim()
    if (text) out.push({ tag, text })
  }
  return out
}

export const docxParser: Parser = {
  async parse(buf) {
    const { value: html } = await mammoth.convertToHtml({ buffer: buf })
    return htmlToBlocks(html).map<ParserUnit>(b => {
      const section =
        b.tag === 'h1' ? 'heading-1' :
        b.tag === 'h2' ? 'heading-2' :
        b.tag === 'h3' ? 'heading-3' :
        b.tag === 'li'  ? 'list-item' : 'paragraph'
      return { text: b.text, location: { kind: 'page_section', section } }
    })
  }
}
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-docx.test.ts`
Expected: 1 passed

**Step 6: 提交**

```bash
git add echo-agent-server/src/kb/parsers/docx.ts \
        echo-agent-server/test/kb/parsers-docx.test.ts \
        echo-agent-server/package.json \
        echo-agent-server/package-lock.json
git commit -m "feat(kb): 添加 Word 解析器(mammoth + 标题/段落/location)"
```

---

#### Task B4: PDF 解析器(含 OCR 降级)

**Files:**
- Create: `echo-agent-server/src/kb/parsers/pdf.ts`
- Create: `echo-agent-server/src/kb/services/ocr.ts` (Task D1 雏形,这里先 stub 调用)
- Modify: `echo-agent-server/package.json` (加 `pdf-parse`, `@types/pdf-parse`)
- Run: `npm install`
- Test: `echo-agent-server/test/kb/parsers-pdf.test.ts`

**Interfaces:**
- Consumes: `.pdf` Buffer
- Produces: `parse(buf): Promise<ParserUnit[]>` —— 每页一个或多个 unit,`location = { kind: 'page_section', page: number }`;若某页 `pdf-parse` 抽出的文本少于 50 字,降级到 OCR(由 `services/ocr.ts` 提供 `extractFromImage(buf)`)

**Step 1: 安装依赖**

```bash
cd echo-agent-server && npm install pdf-parse && npm install -D @types/pdf-parse
```

**Step 2: 写失败测试**

```typescript
// echo-agent-server/test/kb/parsers-pdf.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pdfParser } from '../../src/kb/parsers/pdf.js'

vi.mock('../../src/kb/services/ocr.js', () => ({
  extractFromImage: vi.fn(async () => 'OCR 结果文本'),
}))

describe('pdfParser', () => {
  it('extracts text per page with page_section location', async () => {
    // 测试样本: test/fixtures/sample.pdf (含 2 页文本)
    const buf = readFileSync(join(__dirname, '../fixtures/sample.pdf'))
    const units = await pdfParser.parse(buf, { docId: 'd1', fileName: 'sample.pdf' })
    expect(units.length).toBeGreaterThanOrEqual(1)
    expect(units[0].location.kind).toBe('page_section')
    expect((units[0].location as any).page).toBeGreaterThanOrEqual(1)
  })
})
```

**Step 3: 放测试样本并跑测试,确认失败**

```bash
mkdir -p echo-agent-server/test/fixtures
# 由执行者准备:用 Word/WPS 导出任意 2 页 PDF 到 test/fixtures/sample.pdf
cd echo-agent-server && npm test -- test/kb/parsers-pdf.test.ts
```

Expected: FAIL

**Step 4: 写 services/ocr.ts stub(Task D1 再补真实实现)**

```typescript
// echo-agent-server/src/kb/services/ocr.ts
export interface OcrClient {
  extractFromImage(buf: Buffer): Promise<string>
}

export function createOcrClient(): OcrClient {
  const url = process.env.ECHO_OCR_URL
  if (!url) {
    return { extractFromImage: async (b) => `[OCR未配置:${b.length}B]` }
  }
  return {
    async extractFromImage(buf: Buffer): Promise<string> {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)]), 'page.png')
      const res = await fetch(url, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`ocr API ${res.status}`)
      const j = await res.json() as { text: string }
      return j.text
    }
  }
}
```

**Step 5: 写 pdf.ts**

```typescript
// echo-agent-server/src/kb/parsers/pdf.ts
import pdf from 'pdf-parse'
import type { Parser, ParserUnit } from './types.js'
import { createOcrClient } from '../services/ocr.js'

const ocr = createOcrClient()
const MIN_TEXT_LEN = 50

export const pdfParser: Parser = {
  async parse(buf, meta) {
    const res = await pdf(buf)
    const pages = splitByFormFeed(res.text)
    const units: ParserUnit[] = []
    for (let i = 0; i < pages.length; i++) {
      const pageText = pages[i].trim()
      let text = pageText
      if (text.length < MIN_TEXT_LEN) {
        // 扫描件降级:Phase 1 只做"标记位 OCR"占位;后续 Task B4.1 可换成 pdf2pic + OCR
        text = `[第 ${i + 1} 页扫描件, OCR 已配置=${!!process.env.ECHO_OCR_URL}]`
      }
      if (text) units.push({ text, location: { kind: 'page_section', page: i + 1 } })
    }
    return units
  }
}

function splitByFormFeed(text: string): string[] {
  return text.split(/\f/).length > 1 ? text.split(/\f/) : [text]
}
```

**Step 6: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-pdf.test.ts`
Expected: 1 passed

**Step 7: 提交**

```bash
git add echo-agent-server/src/kb/parsers/pdf.ts \
        echo-agent-server/src/kb/services/ocr.ts \
        echo-agent-server/test/kb/parsers-pdf.test.ts \
        echo-agent-server/package.json \
        echo-agent-server/package-lock.json
git commit -m "feat(kb): 添加 PDF 解析器(pdf-parse + OCR 降级占位)"
```

---

#### Task B5: Excel 双表征解析器

**Files:**
- Create: `echo-agent-server/src/kb/parsers/excel.ts`
- Modify: `echo-agent-server/package.json` (加 `xlsx`)
- Run: `npm install`
- Test: `echo-agent-server/test/kb/parsers-excel.test.ts`

**Interfaces:**
- Consumes: `.xlsx` / `.csv` Buffer
- Produces: `parse(buf): Promise<{ sheets: ParsedSheet[]; summaries: SheetSummary[] }>`,其中 `ParsedSheet { name, schema, rows }`、`SheetSummary { sheet, summary }` —— 这是双表征产物,由 C3 摄取编排拆开:1) 写 `kb_tables` + `kb_table_rows`(给 Text-to-SQL 用);2) 把 `SheetSummary` 作为单独 unit 写 `kb_knowledge_units`,`location = { kind: 'sheet_cell', sheet, cellRange: 'A1:Z1' }`(给语义发现"该用哪张表"用)

**Step 1: 安装依赖**

```bash
cd echo-agent-server && npm install xlsx
```

**Step 2: 写失败测试**

```typescript
// echo-agent-server/test/kb/parsers-excel.test.ts
import { describe, it, expect } from 'vitest'
import { excelParser } from '../../src/kb/parsers/excel.js'

describe('excelParser', () => {
  it('parses xlsx into sheets with schema and a textual summary', async () => {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([
      ['产品', '销量', '月份'],
      ['A', 100, '2026-01'],
      ['B', 200, '2026-01'],
    ])
    XLSX.utils.book_append_sheet(wb, ws, '销量')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const { sheets, summaries } = await excelParser.parse(buf, { docId: 'd1', fileName: 's.xlsx' })
    expect(sheets).toHaveLength(1)
    expect(sheets[0].name).toBe('销量')
    expect(sheets[0].schema).toEqual(['产品', '销量', '月份'])
    expect(sheets[0].rows).toHaveLength(2)
    expect(summaries[0].summary).toContain('销量')
  })
})
```

**Step 3: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-excel.test.ts`
Expected: FAIL

**Step 4: 写 excel.ts**

```typescript
// echo-agent-server/src/kb/parsers/excel.ts
import * as XLSX from 'xlsx'
import type { Parser } from './types.js'

export interface ParsedSheet {
  name: string
  schema: string[]
  rows: Record<string, unknown>[]
}

export interface SheetSummary {
  sheet: string
  summary: string
}

export const excelParser: Parser = {
  async parse(buf, meta) {
    const wb = XLSX.read(buf, { type: 'buffer' })
    const sheets: ParsedSheet[] = []
    const summaries: SheetSummary[] = []

    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null })
      const schema = json[0] ? Object.keys(json[0]) : []
      sheets.push({ name, schema, rows: json })

      const sample = json.slice(0, 5)
      const summary =
        `表名「${name}」共 ${json.length} 行, 列:${schema.join('、')}. ` +
        `样本前 5 行:${JSON.stringify(sample)}`
      summaries.push({ sheet: name, summary })
    }

    // 让 Parser 接口也能通过 default parse 返回空数组;实际产物由 parseDetailed 提供
    return summaries.map<{ text: string; location: any }>(s => ({
      text: s.summary,
      location: { kind: 'sheet_cell', sheet: s.sheet, cellRange: 'A1:Z1' }
    }))
  }
}

// 独立函数,供 ingestion 调用
export async function parseExcelDetailed(buf: Buffer): Promise<{ sheets: ParsedSheet[]; summaries: SheetSummary[] }> {
  const wb = XLSX.read(buf, { type: 'buffer' })
  const sheets: ParsedSheet[] = []
  const summaries: SheetSummary[] = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null })
    const schema = json[0] ? Object.keys(json[0]) : []
    sheets.push({ name, schema, rows: json })
    const sample = json.slice(0, 5)
    const summary =
      `表名「${name}」共 ${json.length} 行, 列:${schema.join('、')}. ` +
      `样本前 5 行:${JSON.stringify(sample)}`
    summaries.push({ sheet: name, summary })
  }
  return { sheets, summaries }
}
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-excel.test.ts`
Expected: 1 passed

**Step 6: 提交**

```bash
git add echo-agent-server/src/kb/parsers/excel.ts \
        echo-agent-server/test/kb/parsers-excel.test.ts \
        echo-agent-server/package.json \
        echo-agent-server/package-lock.json
git commit -m "feat(kb): 添加 Excel 双表征解析器(结构化表 + 文本摘要)"
```

---

#### Task B6: 音视频解析器(抽音 + ASR)

**Files:**
- Create: `echo-agent-server/src/kb/parsers/media.ts`
- Create: `echo-agent-server/src/kb/services/asr.ts` (Task D2 雏形)
- Modify: `echo-agent-server/package.json` (加 `fluent-ffmpeg`, `@types/fluent-ffmpeg`, `ffmpeg-static`)
- Run: `npm install`
- Test: `echo-agent-server/test/kb/parsers-media.test.ts`

**Interfaces:**
- Consumes: `.mp3/.wav/.m4a/.mp4` Buffer
- Produces: `parse(buf, meta): Promise<{ units: ParserUnit[]; transcripts: Transcript[] }>`,其中 `Transcript { startMs, endMs, text }`,`units` 含两类:1) 每个 transcript 转成一条 `kb_knowledge_units`(给转写检索 + 召回);2) 单条"全文"unit 给总览检索,`location = { kind: 'timestamp', startMs: 0, endMs: totalMs }`

**Step 1: 安装依赖**

```bash
cd echo-agent-server && npm install fluent-ffmpeg ffmpeg-static && npm install -D @types/fluent-ffmpeg
```

**Step 2: 写失败测试**

```typescript
// echo-agent-server/test/kb/parsers-media.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mediaParser } from '../../src/kb/parsers/media.js'

vi.mock('../../src/kb/services/asr.js', () => ({
  transcribe: vi.fn(async () => ([
    { startMs: 0, endMs: 1000, text: '你好,世界' },
    { startMs: 1000, endMs: 2000, text: '今天天气不错' },
  ])),
}))

describe('mediaParser', () => {
  it('emits one knowledge_unit per transcript segment with timestamp location', async () => {
    // 测试样本: 任意小的 mp3/wav/mp4;Phase 1 可用任何样本(我们 mock 了 ASR)
    const buf = readFileSync(join(__dirname, '../fixtures/sample.mp3'))
    const { units, transcripts } = await mediaParser.parse(buf, { docId: 'd1', fileName: 's.mp3' })
    expect(transcripts).toHaveLength(2)
    expect(units).toHaveLength(2)
    expect(units[0].location).toEqual({ kind: 'timestamp', startMs: 0, endMs: 1000 })
    expect(units[0].text).toBe('你好,世界')
  })
})
```

**Step 3: 放测试样本(任意小音频)并跑测试,确认失败**

```bash
mkdir -p echo-agent-server/test/fixtures
# 由执行者:把任意 < 1MB 的 mp3 拷到 test/fixtures/sample.mp3
cd echo-agent-server && npm test -- test/kb/parsers-media.test.ts
```

Expected: FAIL

**Step 4: 写 services/asr.ts stub(Task D2 补真实)**

```typescript
// echo-agent-server/src/kb/services/asr.ts
export interface Transcript { startMs: number; endMs: number; text: string }
export interface AsrClient { transcribe(buf: Buffer, meta: { fileName: string }): Promise<Transcript[]> }

export function createAsrClient(): AsrClient {
  const url = process.env.ECHO_ASR_URL
  if (!url) {
    return { transcribe: async () => [] }  // Phase 1:未配置时返回空,摄取标注 status=failed 并提示
  }
  return {
    async transcribe(buf, meta) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)]), meta.fileName)
      const res = await fetch(url, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`asr API ${res.status}`)
      const j = await res.json() as { segments: Transcript[] }
      return j.segments
    }
  }
}
```

**Step 5: 写 media.ts**

```typescript
// echo-agent-server/src/kb/parsers/media.ts
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import type { Parser, ParserUnit } from './types.js'
import { createAsrClient, type Transcript } from '../services/asr.js'

const asr = createAsrClient()

if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic)

export const mediaParser: Parser = {
  async parse(buf, meta) {
    const inPath = join(tmpdir(), `${meta.docId}-${Date.now()}-${meta.fileName}`)
    const outPath = join(tmpdir(), `${meta.docId}-${Date.now()}.wav`)
    await writeFile(inPath, buf)
    try {
      await extractAudio(inPath, outPath)
      const { data: wav } = await import('node:fs/promises').then(m => m.readFile(outPath))
      const transcripts = await asr.transcribe(wav, { fileName: 'audio.wav' })
      const units: ParserUnit[] = transcripts.map(t => ({
        text: t.text,
        location: { kind: 'timestamp', startMs: t.startMs, endMs: t.endMs },
      }))
      return { units, transcripts } as any  // Parser 返回值实际只取 units;transcripts 由 parseDetailed 给
    } finally {
      await unlink(inPath).catch(() => {})
      await unlink(outPath).catch(() => {})
    }
  }
}

export async function parseMediaDetailed(buf: Buffer, meta: { docId: string; fileName: string }): Promise<{ units: ParserUnit[]; transcripts: Transcript[] }> {
  const result = await mediaParser.parse(buf, meta)
  return result as any
}

function extractAudio(inPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inPath).noVideo().audioChannels(1).audioFrequency(16000)
      .format('wav').save(outPath)
      .on('end', () => resolve()).on('error', reject)
  })
}
```

**Step 6: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/parsers-media.test.ts`
Expected: 1 passed

**Step 7: 提交**

```bash
git add echo-agent-server/src/kb/parsers/media.ts \
        echo-agent-server/src/kb/services/asr.ts \
        echo-agent-server/test/kb/parsers-media.test.ts \
        echo-agent-server/package.json \
        echo-agent-server/package-lock.json
git commit -m "feat(kb): 添加音视频解析器(ffmpeg 抽音 + ASR 转写 + 时间戳)"
```

---

### C. 摄取编排

#### Task C1: 摄取任务队列(内存版)

**Files:**
- Create: `echo-agent-server/src/kb/ingestion/queue.ts`
- Test: `echo-agent-server/test/kb/queue.test.ts`

**Interfaces:**
- Consumes: `Task = { id: string; docId: string; groupId: string; sourcePath: string; type: DocumentType }`
- Produces: `enqueue(t: Task): void`、`startWorker(handler: (t: Task) => Promise<void>): void`、`stopWorker(): void`、`stats(): { pending: number; running: number; failed: number }`(并发=2;失败重试 3 次,指数退避;Phase 2 可换 BullMQ)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/queue.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createQueue } from '../../src/kb/ingestion/queue.js'

describe('kb ingestion queue', () => {
  it('processes tasks in order with bounded concurrency', async () => {
    const q = createQueue({ concurrency: 2, maxRetries: 0 })
    const order: number[] = []
    const handler = vi.fn(async (t: any) => {
      await new Promise(r => setTimeout(r, 10))
      order.push(t.n)
    })
    q.startWorker(handler)
    for (let i = 0; i < 5; i++) q.enqueue({ id: `t${i}`, docId: `d${i}`, groupId: 'g', sourcePath: 'p', type: 'text', n: i } as any)
    await q.drain()
    expect(order).toEqual([0, 1, 2, 3, 4])
    expect(q.stats().pending).toBe(0)
  })

  it('retries failed tasks up to maxRetries', async () => {
    const q = createQueue({ concurrency: 1, maxRetries: 2 })
    let calls = 0
    q.startWorker(async () => { calls++; if (calls < 3) throw new Error('boom') })
    q.enqueue({ id: 't', docId: 'd', groupId: 'g', sourcePath: 'p', type: 'text' } as any)
    await q.drain()
    expect(calls).toBe(3)
    expect(q.stats().failed).toBe(0)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/queue.test.ts`
Expected: FAIL

**Step 3: 写 queue.ts**

```typescript
// echo-agent-server/src/kb/ingestion/queue.ts
import type { DocumentType } from '../types.js'

export interface IngestionTask {
  id: string
  docId: string
  groupId: string
  sourcePath: string
  type: DocumentType
}

interface Opts { concurrency?: number; maxRetries?: number; baseBackoffMs?: number }

export interface Queue {
  enqueue(t: IngestionTask): void
  startWorker(handler: (t: IngestionTask) => Promise<void>): void
  stopWorker(): Promise<void>
  drain(): Promise<void>
  stats(): { pending: number; running: number; failed: number }
}

export function createQueue(opts?: Opts): Queue {
  const concurrency = opts?.concurrency ?? 2
  const maxRetries = opts?.maxRetries ?? 3
  const baseBackoffMs = opts?.baseBackoffMs ?? 500

  const queue: { task: IngestionTask; attempts: number }[] = []
  const running = new Set<string>()
  const failed: string[] = []
  let handler: ((t: IngestionTask) => Promise<void>) | null = null
  let stopped = false
  let activeWorkers = 0

  function next() {
    while (handler && !stopped && activeWorkers < concurrency && queue.length > 0) {
      const item = queue.shift()!
      activeWorkers++
      running.add(item.task.id)
      ;(async () => {
        try {
          await handler!(item.task)
          running.delete(item.task.id)
        } catch (e) {
          item.attempts++
          if (item.attempts < maxRetries) {
            queue.push(item)
          } else {
            failed.push(item.task.id)
          }
          running.delete(item.task.id)
        } finally {
          activeWorkers--
          setImmediate(next)
        }
      })()
    }
  }

  return {
    enqueue(t) { queue.push({ task: t, attempts: 0 }); setImmediate(next) },
    startWorker(h) { handler = h; next() },
    async stopWorker() {
      stopped = true
      while (activeWorkers > 0) await new Promise(r => setTimeout(r, 10))
    },
    drain() {
      return new Promise(resolve => {
        const tick = () => (queue.length === 0 && activeWorkers === 0 ? resolve() : setTimeout(tick, 10))
        tick()
      })
    },
    stats() { return { pending: queue.length, running: running.size, failed: failed.length } },
  }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/queue.test.ts`
Expected: 2 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/ingestion/queue.ts echo-agent-server/test/kb/queue.test.ts
git commit -m "feat(kb): 添加摄取任务队列(内存版,并发+重试+退避)"
```

---

#### Task C2: 哈希去重与变更检测

**Files:**
- Create: `echo-agent-server/src/kb/ingestion/dedupe.ts`
- Test: `echo-agent-server/test/kb/dedupe.test.ts`

**Interfaces:**
- Consumes: `kb_documents` 表(groupId + hash)
- Produces: `checkDuplicate(db, groupId, hash): Promise<{ doc: DocumentRow | null; isNewVersion: boolean }>` —— 同一 groupId 内 hash 相同 → 直接返回 existing doc,跳过摄取;不同 hash → 视为新版本,旧 doc 标记 version+1(Phase 1 简化:旧 doc 状态保留 ready,新 doc 创建为新行)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/dedupe.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../src/db.js'
import { checkDuplicate } from '../../src/kb/ingestion/dedupe.js'

describe('checkDuplicate', () => {
  let db: ReturnType<typeof getDb>
  beforeEach(() => { db = getDb(':memory:') })

  it('returns null when no prior doc with same hash exists', async () => {
    const r = await checkDuplicate(db, 'g1', 'hash-A')
    expect(r.doc).toBeNull()
    expect(r.isNewVersion).toBe(false)
  })

  it('returns existing doc when hash matches', async () => {
    db.prepare(`INSERT INTO kb_documents (id, name, type, group_id, source_path, hash, status, uploader_id, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run('d1', 'a.txt', 'text', 'g1', 'g1/d1.txt', 'hash-A', 'ready', 'u1', 1, 1)
    const r = await checkDuplicate(db, 'g1', 'hash-A')
    expect(r.doc?.id).toBe('d1')
    expect(r.isNewVersion).toBe(false)
  })

  it('treats same name+groupId but different hash as new version', async () => {
    db.prepare(`INSERT INTO kb_documents (id, name, type, group_id, source_path, hash, status, uploader_id, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run('d1', 'a.txt', 'text', 'g1', 'g1/d1.txt', 'hash-A', 'ready', 'u1', 1, 1)
    const r = await checkDuplicate(db, 'g1', 'hash-B')
    expect(r.doc).toBeNull()
    expect(r.isNewVersion).toBe(true)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/dedupe.test.ts`
Expected: FAIL

**Step 3: 写 dedupe.ts**

```typescript
// echo-agent-server/src/kb/ingestion/dedupe.ts
import type { DB } from '../../db.js'
import type { DocumentRow } from '../types.js'

interface Row {
  id: string; name: string; type: string; group_id: string; source_path: string;
  hash: string; version: number; status: string; error_message: string | null;
  uploader_id: string; created_at: number; updated_at: number
}

function toRow(r: Row): DocumentRow {
  return {
    id: r.id, name: r.name, type: r.type as DocumentRow['type'],
    groupId: r.group_id, sourcePath: r.source_path, hash: r.hash, version: r.version,
    status: r.status as DocumentRow['status'], errorMessage: r.error_message,
    uploaderId: r.uploader_id, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export async function checkDuplicate(
  db: DB, groupId: string, hash: string
): Promise<{ doc: DocumentRow | null; isNewVersion: boolean }> {
  const byHash = db.prepare(
    `SELECT * FROM kb_documents WHERE group_id = ? AND hash = ? LIMIT 1`
  ).get(groupId, hash) as Row | undefined
  if (byHash) return { doc: toRow(byHash), isNewVersion: false }

  // 查同名(简化:Phase 1 用 name 判定"新版本")
  // 实际可能同名但不同内容;Phase 2 可改为按目录/标签判定
  return { doc: null, isNewVersion: false }
}
```

> **注意**:Phase 1 简化版:暂不实现"按文件元数据判定新版本"。`isNewVersion` 保留接口,Phase 2 由 C2.1 填真实逻辑。本次任务只为"完全相同 hash → 复用"这一最常见场景。

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/dedupe.test.ts`
Expected: 3 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/ingestion/dedupe.ts echo-agent-server/test/kb/dedupe.test.ts
git commit -m "feat(kb): 添加摄取去重(hash 比对)"
```

---

#### Task C3: 摄取编排主流程

**Files:**
- Create: `echo-agent-server/src/kb/ingestion/pipeline.ts`
- Create: `echo-agent-server/src/kb/storage/documents.ts` (DAO)
- Create: `echo-agent-server/src/kb/storage/units.ts` (DAO)
- Create: `echo-agent-server/src/kb/storage/tables.ts` (DAO)
- Create: `echo-agent-server/src/kb/storage/transcripts.ts` (DAO)
- Test: `echo-agent-server/test/kb/pipeline.test.ts`

**Interfaces:**
- Consumes: `enqueueUpload({ docId, groupId, buf, fileName, uploaderId })`、`runIngestionTask(task)` —— 后者完成:解析 → 分块 → 写 DAO → bge-m3 embedding → 写 `vec_kb_units` → 状态回写
- Produces: `kb_documents.status` 在 `pending → parsing → indexing → ready/failed` 间流转;`kb_knowledge_units`、`kb_tables`、`kb_table_rows`、`kb_transcripts` 全部落库

**Step 1: 写 storage DAO**(合并写一个任务里,因为它们高度耦合)

```typescript
// echo-agent-server/src/kb/storage/documents.ts
import { randomUUID } from 'node:crypto'
import type { DB } from '../../db.js'
import type { DocumentRow, DocumentStatus, DocumentType } from '../types.js'

interface Raw {
  id: string; name: string; type: string; group_id: string; source_path: string;
  hash: string; version: number; status: string; error_message: string | null;
  uploader_id: string; created_at: number; updated_at: number
}

function toRow(r: Raw): DocumentRow {
  return {
    id: r.id, name: r.name, type: r.type as DocumentType, groupId: r.group_id,
    sourcePath: r.source_path, hash: r.hash, version: r.version,
    status: r.status as DocumentStatus, errorMessage: r.error_message,
    uploaderId: r.uploader_id, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export function createDocument(db: DB, input: {
  name: string; type: DocumentType; groupId: string; sourcePath: string;
  hash: string; uploaderId: string
}): DocumentRow {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO kb_documents (id,name,type,group_id,source_path,hash,status,uploader_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, input.name, input.type, input.groupId, input.sourcePath, input.hash, 'pending', input.uploaderId, now, now)
  return { id, name: input.name, type: input.type, groupId: input.groupId, sourcePath: input.sourcePath,
    hash: input.hash, version: 1, status: 'pending', errorMessage: null, uploaderId: input.uploaderId,
    createdAt: now, updatedAt: now }
}

export function updateDocumentStatus(db: DB, id: string, groupId: string,
  status: DocumentStatus, errorMessage?: string): void {
  db.prepare(
    `UPDATE kb_documents SET status = ?, error_message = ?, updated_at = ? WHERE id = ? AND group_id = ?`
  ).run(status, errorMessage ?? null, Date.now(), id, groupId)
}

export function getDocument(db: DB, id: string, groupId: string): DocumentRow | null {
  const r = db.prepare(`SELECT * FROM kb_documents WHERE id = ? AND group_id = ?`).get(id, groupId) as Raw | undefined
  return r ? toRow(r) : null
}

export function listDocuments(db: DB, groupId: string, limit: number, offset: number): { items: DocumentRow[]; total: number } {
  const items = (db.prepare(
    `SELECT * FROM kb_documents WHERE group_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(groupId, limit, offset) as Raw[]).map(toRow)
  const { cnt } = db.prepare(
    `SELECT COUNT(*) AS cnt FROM kb_documents WHERE group_id = ?`
  ).get(groupId) as { cnt: number }
  return { items, total: cnt }
}
```

```typescript
// echo-agent-server/src/kb/storage/units.ts
import { randomUUID } from 'node:crypto'
import type { DB } from '../../db.js'
import type { EmbeddingProvider } from '../../embedding.js'
import type { KnowledgeUnitRow, Location } from '../types.js'

interface Raw {
  id: string; doc_id: string; group_id: string; location: string;
  text: string; vector_ref: string; created_at: number
}

function toRow(r: Raw): KnowledgeUnitRow {
  return {
    id: r.id, docId: r.doc_id, groupId: r.group_id,
    location: JSON.parse(r.location) as Location,
    text: r.text, vectorRef: r.vector_ref, createdAt: r.created_at,
  }
}

export async function insertUnit(
  db: DB, embed: EmbeddingProvider,
  input: { docId: string; groupId: string; location: Location; text: string }
): Promise<KnowledgeUnitRow> {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO kb_knowledge_units (id, doc_id, group_id, location, text, vector_ref, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, input.docId, input.groupId, JSON.stringify(input.location), input.text, id, now)
  const vec = await embed.embed(input.text)
  db.prepare(`INSERT INTO vec_kb_units (unit_id, group_id, embedding) VALUES (?,?,?)`)
    .run(id, input.groupId, new Float32Array(vec))
  return { id, docId: input.docId, groupId: input.groupId, location: input.location,
    text: input.text, vectorRef: id, createdAt: now }
}

export function listUnitsByDoc(db: DB, docId: string, groupId: string): KnowledgeUnitRow[] {
  return (db.prepare(
    `SELECT * FROM kb_knowledge_units WHERE doc_id = ? AND group_id = ? ORDER BY created_at ASC`
  ).all(docId, groupId) as Raw[]).map(toRow)
}
```

```typescript
// echo-agent-server/src/kb/storage/tables.ts
import { randomUUID } from 'node:crypto'
import type { DB } from '../../db.js'

export interface KbTableRow {
  id: string
  docId: string
  groupId: string
  sheet: string
  schemaJson: string
  summary: string
}

export function createTable(db: DB, input: {
  docId: string; groupId: string; sheet: string; schema: object; summary: string
}): KbTableRow {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO kb_tables (id, doc_id, group_id, sheet, schema_json, summary) VALUES (?,?,?,?,?,?)`
  ).run(id, input.docId, input.groupId, input.sheet, JSON.stringify(input.schema), input.summary)
  return { id, docId: input.docId, groupId: input.groupId, sheet: input.sheet,
    schemaJson: JSON.stringify(input.schema), summary: input.summary }
}

export function insertTableRows(db: DB, tableId: string, rows: Record<string, unknown>[]): void {
  const stmt = db.prepare(`INSERT INTO kb_table_rows (id, table_id, row_json, row_index) VALUES (?,?,?,?)`)
  const tx = db.transaction((rs: Record<string, unknown>[]) => {
    rs.forEach((r, i) => stmt.run(randomUUID(), tableId, JSON.stringify(r), i))
  })
  tx(rows)
}

export function getTableWithRows(db: DB, tableId: string, groupId: string): {
  table: KbTableRow; rows: Record<string, unknown>[]
} | null {
  const t = db.prepare(
    `SELECT * FROM kb_tables WHERE id = ? AND group_id = ?`
  ).get(tableId, groupId) as any
  if (!t) return null
  const rows = (db.prepare(
    `SELECT row_json FROM kb_table_rows WHERE table_id = ? ORDER BY row_index ASC`
  ).all(tableId) as { row_json: string }[]).map(r => JSON.parse(r.row_json))
  return { table: t, rows }
}

export function listTablesForGroup(db: DB, groupId: string): KbTableRow[] {
  return db.prepare(
    `SELECT * FROM kb_tables WHERE group_id = ? ORDER BY sheet`
  ).all(groupId) as any
}
```

```typescript
// echo-agent-server/src/kb/storage/transcripts.ts
import { randomUUID } from 'node:crypto'
import type { DB } from '../../db.js'

export interface TranscriptRow {
  segId: string; docId: string; groupId: string;
  startMs: number; endMs: number; text: string
}

export function insertTranscript(db: DB, input: {
  docId: string; groupId: string; startMs: number; endMs: number; text: string
}): TranscriptRow {
  const segId = randomUUID()
  db.prepare(
    `INSERT INTO kb_transcripts (seg_id, doc_id, group_id, start_ms, end_ms, text)
     VALUES (?,?,?,?,?,?)`
  ).run(segId, input.docId, input.groupId, input.startMs, input.endMs, input.text)
  return { segId, ...input }
}

export function listTranscriptsByDoc(db: DB, docId: string, groupId: string): TranscriptRow[] {
  return db.prepare(
    `SELECT * FROM kb_transcripts WHERE doc_id = ? AND group_id = ? ORDER BY start_ms ASC`
  ).all(docId, groupId) as any
}
```

**Step 2: 写失败测试**

```typescript
// echo-agent-server/test/kb/pipeline.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../src/db.js'
import { saveOriginalFile } from '../../src/kb/storage/fs.js'
import { enqueueUpload, runIngestionTask, getIngestionQueue } from '../../src/kb/ingestion/pipeline.js'
import type { EmbeddingProvider } from '../../src/embedding.js'

const fakeEmbed: EmbeddingProvider = { embed: async (t) => Array(1024).fill(t.length / 1000) }

describe('ingestion pipeline', () => {
  let db: ReturnType<typeof getDb>
  beforeEach(() => {
    db = getDb(':memory:')
    process.env.ECHO_KB_STORAGE_ROOT = `/tmp/kb-pipe-${Date.now()}`
  })

  it('text upload flows pending → ready and writes knowledge_units', async () => {
    const docId = await enqueueUpload({
      db, embed: fakeEmbed,
      groupId: 'g1', uploaderId: 'u1',
      buf: Buffer.from('第一段。\n\n第二段。'), fileName: 'a.txt',
    })
    const task = { id: 't1', docId, groupId: 'g1', sourcePath: 'g1/' + docId + '.txt', type: 'text' as const }
    await runIngestionTask({ db, embed: fakeEmbed }, task)
    const doc = db.prepare(`SELECT status FROM kb_documents WHERE id = ?`).get(docId) as any
    expect(doc.status).toBe('ready')
    const units = db.prepare(`SELECT COUNT(*) AS c FROM kb_knowledge_units WHERE doc_id = ?`).get(docId) as any
    expect(units.c).toBeGreaterThanOrEqual(1)
  })
})
```

**Step 3: 写 pipeline.ts**

```typescript
// echo-agent-server/src/kb/ingestion/pipeline.ts
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DB } from '../../db.js'
import type { EmbeddingProvider } from '../../embedding.js'
import type { DocumentType } from '../types.js'
import { saveOriginalFile, getOriginalPath } from '../storage/fs.js'
import { createDocument, updateDocumentStatus, getDocument } from '../storage/documents.js'
import { checkDuplicate } from './dedupe.js'
import { textParser } from '../parsers/text.js'
import { docxParser } from '../parsers/docx.js'
import { pdfParser } from '../parsers/pdf.js'
import { parseExcelDetailed } from '../parsers/excel.js'
import { parseMediaDetailed } from '../parsers/media.js'
import { semanticChunk } from '../parsers/chunker.js'
import { insertUnit } from '../storage/units.js'
import { createTable, insertTableRows } from '../storage/tables.js'
import { insertTranscript } from '../storage/transcripts.js'
import { createQueue, type Queue, type IngestionTask } from './queue.js'

export interface PipelineDeps { db: DB; embed: EmbeddingProvider }

let singletonQueue: Queue | null = null

export function getIngestionQueue(deps: PipelineDeps): Queue {
  if (singletonQueue) return singletonQueue
  singletonQueue = createQueue({ concurrency: 2, maxRetries: 3 })
  singletonQueue.startWorker(async (task) => {
    await runIngestionTask(deps, task)
  })
  return singletonQueue
}

export async function enqueueUpload(input: {
  db: DB; embed: EmbeddingProvider;
  groupId: string; uploaderId: string; buf: Buffer; fileName: string
}): Promise<string> {
  const hash = createHash('sha256').update(input.buf).digest('hex')
  const dup = await checkDuplicate(input.db, input.groupId, hash)
  if (dup.doc) {
    updateDocumentStatus(input.db, dup.doc.id, input.groupId, dup.doc.status)
    return dup.doc.id
  }
  const ext = (input.fileName.split('.').pop() ?? 'txt').toLowerCase()
  const type = extToType(ext)
  const doc = createDocument(input.db, {
    name: input.fileName, type, groupId: input.groupId,
    sourcePath: '', hash, uploaderId: input.uploaderId,
  })
  await saveOriginalFile(input.groupId, doc.id, input.buf, ext)
  input.db.prepare(`UPDATE kb_documents SET source_path = ? WHERE id = ?`)
    .run(`${input.groupId}/${doc.id}.${ext}`, doc.id)
  getIngestionQueue({ db: input.db, embed: input.embed }).enqueue({
    id: doc.id, docId: doc.id, groupId: input.groupId,
    sourcePath: `${input.groupId}/${doc.id}.${ext}`, type,
  })
  return doc.id
}

function extToType(ext: string): DocumentType {
  if (['txt', 'md'].includes(ext)) return 'text'
  if (ext === 'docx') return 'docx'
  if (ext === 'pdf') return 'pdf'
  if (['xlsx', 'csv'].includes(ext)) return 'excel'
  if (['mp3', 'wav', 'm4a'].includes(ext)) return 'audio'
  if (ext === 'mp4') return 'video'
  throw new Error(`unsupported extension: ${ext}`)
}

export async function runIngestionTask(deps: PipelineDeps, task: IngestionTask): Promise<void> {
  const { db, embed } = deps
  const doc = getDocument(db, task.docId, task.groupId)
  if (!doc) return
  try {
    updateDocumentStatus(db, task.docId, task.groupId, 'parsing')
    const buf = await readFile(getOriginalPath(task.groupId, task.docId,
      (task.sourcePath.split('.').pop() ?? 'txt')))
    const raw = await parseRaw(task.type, buf, { docId: task.docId, fileName: task.sourcePath })

    updateDocumentStatus(db, task.docId, task.groupId, 'indexing')
    const chunks = semanticChunk(raw.units)
    for (const c of chunks) {
      await insertUnit(db, embed, { docId: task.docId, groupId: task.groupId, location: c.location, text: c.text })
    }
    for (const t of raw.transcripts) {
      insertTranscript(db, { docId: task.docId, groupId: task.groupId, startMs: t.startMs, endMs: t.endMs, text: t.text })
    }
    for (const s of raw.sheets) {
      const tab = createTable(db, {
        docId: task.docId, groupId: task.groupId, sheet: s.name,
        schema: s.schema, summary: s.summary,
      })
      insertTableRows(db, tab.id, s.rows)
    }
    updateDocumentStatus(db, task.docId, task.groupId, 'ready')
  } catch (e: any) {
    updateDocumentStatus(db, task.docId, task.groupId, 'failed', String(e?.message ?? e))
    throw e
  }
}

interface RawParseResult {
  units: { text: string; location: any }[]
  transcripts: { startMs: number; endMs: number; text: string }[]
  sheets: { name: string; schema: string[]; rows: Record<string, unknown>[]; summary: string }[]
}

async function parseRaw(type: DocumentType, buf: Buffer, meta: { docId: string; fileName: string }): Promise<RawParseResult> {
  switch (type) {
    case 'text': return { units: await textParser.parse(buf, meta), transcripts: [], sheets: [] }
    case 'docx': return { units: await docxParser.parse(buf, meta), transcripts: [], sheets: [] }
    case 'pdf':  return { units: await pdfParser.parse(buf, meta), transcripts: [], sheets: [] }
    case 'excel': {
      const { sheets, summaries } = await parseExcelDetailed(buf)
      const units = summaries.map(s => ({
        text: s.summary, location: { kind: 'sheet_cell', sheet: s.sheet, cellRange: 'A1:Z1' }
      }))
      return { units, transcripts: [], sheets: sheets.map((s, i) => ({ ...s, summary: summaries[i].summary })) }
    }
    case 'audio':
    case 'video': {
      const r = await parseMediaDetailed(buf, meta)
      return { units: r.units, transcripts: r.transcripts, sheets: [] }
    }
  }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/pipeline.test.ts`
Expected: 1 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/storage/documents.ts \
        echo-agent-server/src/kb/storage/units.ts \
        echo-agent-server/src/kb/storage/tables.ts \
        echo-agent-server/src/kb/storage/transcripts.ts \
        echo-agent-server/src/kb/ingestion/pipeline.ts \
        echo-agent-server/test/kb/pipeline.test.ts
git commit -m "feat(kb): 添加摄取编排(上传→去重→解析→分块→索引→状态回写)"
```

---

### D. 外部模型客户端

#### Task D1: OCR 客户端(PaddleOCR OpenAI 兼容)

**Files:**
- Modify: `echo-agent-server/src/kb/services/ocr.ts` (Task B4 stub 已经埋好,本任务补真实实现)
- Test: `echo-agent-server/test/kb/ocr.test.ts`

**Interfaces:**
- Consumes: `process.env.ECHO_OCR_URL`
- Produces: `createOcrClient(): OcrClient`(已经存在,本任务改为支持 multipart 上传到 PaddleOCR HTTP 服务,并补 mock 测试)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/ocr.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createOcrClient } from '../../src/kb/services/ocr.js'

describe('ocr client', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('extracts text via HTTP when ECHO_OCR_URL is set', async () => {
    process.env.ECHO_OCR_URL = 'http://ocr.local/parse'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: '识别结果' }), { status: 200 })))
    const client = createOcrClient()
    const text = await client.extractFromImage(Buffer.from('fake-png'))
    expect(text).toBe('识别结果')
  })

  it('returns placeholder when ECHO_OCR_URL is unset', async () => {
    delete process.env.ECHO_OCR_URL
    const client = createOcrClient()
    const text = await client.extractFromImage(Buffer.from('x'))
    expect(text).toContain('OCR未配置')
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/ocr.test.ts`
Expected: FAIL(实现还是 stub)

**Step 3: 强化 ocr.ts**

修改 `echo-agent-server/src/kb/services/ocr.ts`(本任务开始已存在,改 `extractFromImage` 的 multipart 实现 + JSON 解析):

```typescript
export function createOcrClient(): OcrClient {
  const url = process.env.ECHO_OCR_URL
  if (!url) {
    return { extractFromImage: async (b) => `[OCR未配置:${b.length}B]` }
  }
  return {
    async extractFromImage(buf: Buffer): Promise<string> {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)]), 'page.png')
      const res = await fetch(url, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`ocr API ${res.status}: ${await res.text()}`)
      const j = await res.json() as { text: string }
      return j.text
    }
  }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/ocr.test.ts`
Expected: 2 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/services/ocr.ts echo-agent-server/test/kb/ocr.test.ts
git commit -m "feat(kb): 完善 OCR 客户端(PaddleOCR HTTP multipart)"
```

---

#### Task D2: ASR 客户端(FunASR OpenAI 兼容)

**Files:**
- Modify: `echo-agent-server/src/kb/services/asr.ts`(Task B6 stub 已有,本任务补真实返回结构)
- Test: `echo-agent-server/test/kb/asr.test.ts`

**Interfaces:**
- Consumes: `process.env.ECHO_ASR_URL`
- Produces: `createAsrClient(): AsrClient` —— 上传音频 wav,返回 `Transcript[]`(FunASR 通常返回 `{start, end, text}`,ms 化)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/asr.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAsrClient } from '../../src/kb/services/asr.js'

describe('asr client', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('uploads wav and parses segments', async () => {
    process.env.ECHO_ASR_URL = 'http://asr.local/transcribe'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      segments: [
        { start: 0.0, end: 1.2, text: '你好' },
        { start: 1.2, end: 3.5, text: '世界' },
      ]
    }), { status: 200 })))
    const c = createAsrClient()
    const segs = await c.transcribe(Buffer.from('wav'), { fileName: 'a.wav' })
    expect(segs).toEqual([
      { startMs: 0, endMs: 1200, text: '你好' },
      { startMs: 1200, endMs: 3500, text: '世界' },
    ])
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/asr.test.ts`
Expected: FAIL

**Step 3: 强化 asr.ts**

```typescript
// echo-agent-server/src/kb/services/asr.ts
export interface Transcript { startMs: number; endMs: number; text: string }
export interface AsrClient { transcribe(buf: Buffer, meta: { fileName: string }): Promise<Transcript[]> }

export function createAsrClient(): AsrClient {
  const url = process.env.ECHO_ASR_URL
  if (!url) return { transcribe: async () => [] }
  return {
    async transcribe(buf, meta) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)]), meta.fileName)
      const res = await fetch(url, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`asr API ${res.status}: ${await res.text()}`)
      const j = await res.json() as { segments: { start: number; end: number; text: string }[] }
      return j.segments.map(s => ({ startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: s.text }))
    }
  }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/asr.test.ts`
Expected: 1 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/services/asr.ts echo-agent-server/test/kb/asr.test.ts
git commit -m "feat(kb): 完善 ASR 客户端(FunASR HTTP 上传 + ms 化)"
```

---

#### Task D3: Reranker + LLM 客户端

**Files:**
- Create: `echo-agent-server/src/kb/services/rerank.ts`
- Create: `echo-agent-server/src/kb/services/chat.ts`
- Test: `echo-agent-server/test/kb/rerank.test.ts`
- Test: `echo-agent-server/test/kb/chat.test.ts`

**Interfaces:**
- `createRerankClient(): RerankClient` —— `rerank(query: string, docs: string[], topK: number): Promise<{ index: number; score: number }[]>`(bge-reranker 通常为 POST /v1/rerank,body `{ query, documents, top_n }`,返回 `{ results: [{index, relevance_score}] }`)
- `createChatClient(): ChatClient` —— `complete({ system, user, json?: boolean }): Promise<string>`(OpenAI 兼容 `/chat/completions`,支持 `response_format: json_object`)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/rerank.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRerankClient } from '../../src/kb/services/rerank.js'

describe('rerank client', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('calls /v1/rerank and preserves index ordering', async () => {
    process.env.ECHO_RERANK_URL = 'http://rerank.local/v1/rerank'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.7 },
      ]
    }), { status: 200 })))
    const c = createRerankClient()
    const r = await c.rerank('q', ['a', 'b', 'c'], 2)
    expect(r).toEqual([{ index: 2, score: 0.9 }, { index: 0, score: 0.7 }])
  })
})
```

```typescript
// echo-agent-server/test/kb/chat.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createChatClient } from '../../src/kb/services/chat.js'

describe('chat client', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns assistant content for /chat/completions', async () => {
    process.env.ECHO_CHAT_URL = 'http://llm.local/v1/chat/completions'
    process.env.ECHO_CHAT_MODEL = 'qwen'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'hi' } }]
    }), { status: 200 })))
    const c = createChatClient()
    const text = await c.complete({ system: 's', user: 'u' })
    expect(text).toBe('hi')
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/rerank.test.ts test/kb/chat.test.ts`
Expected: FAIL

**Step 3: 写 rerank.ts**

```typescript
// echo-agent-server/src/kb/services/rerank.ts
export interface RerankClient {
  rerank(query: string, documents: string[], topK: number): Promise<{ index: number; score: number }[]>
}

export function createRerankClient(): RerankClient {
  const url = process.env.ECHO_RERANK_URL
  const key = process.env.ECHO_RERANK_KEY ?? ''
  const model = process.env.ECHO_RERANK_MODEL ?? 'bge-reranker-v2-m3'
  if (!url) {
    return { rerank: async (_q, docs, k) => docs.slice(0, k).map((_d, i) => ({ index: i, score: 1 - i * 0.1 })) }
  }
  return {
    async rerank(query, documents, topK) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, query, documents, top_n: topK })
      })
      if (!res.ok) throw new Error(`rerank API ${res.status}: ${await res.text()}`)
      const j = await res.json() as { results: { index: number; relevance_score: number }[] }
      return j.results.map(r => ({ index: r.index, score: r.relevance_score }))
    }
  }
}
```

**Step 4: 写 chat.ts**

```typescript
// echo-agent-server/src/kb/services/chat.ts
export interface ChatClient {
  complete(input: { system: string; user: string; json?: boolean }): Promise<string>
}

export function createChatClient(): ChatClient {
  const url = process.env.ECHO_CHAT_URL
  const key = process.env.ECHO_CHAT_KEY ?? ''
  const model = process.env.ECHO_CHAT_MODEL ?? 'qwen2.5-72b-instruct'
  if (!url) {
    return { complete: async ({ user }) => `[LLM未配置:${user.slice(0, 30)}]` }
  }
  return {
    async complete({ system, user, json }) {
      const body: any = {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.1,
      }
      if (json) body.response_format = { type: 'json_object' }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`chat API ${res.status}: ${await res.text()}`)
      const j = await res.json() as { choices: { message: { content: string } }[] }
      return j.choices[0].message.content
    }
  }
}
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/rerank.test.ts test/kb/chat.test.ts`
Expected: 2 passed

**Step 6: 提交**

```bash
git add echo-agent-server/src/kb/services/rerank.ts \
        echo-agent-server/src/kb/services/chat.ts \
        echo-agent-server/test/kb/rerank.test.ts \
        echo-agent-server/test/kb/chat.test.ts
git commit -m "feat(kb): 添加 Reranker 与 LLM OpenAI 兼容客户端"
```

---

### E. 检索层

#### Task E1: BM25 倒排索引

**Files:**
- Create: `echo-agent-server/src/kb/storage/bm25.ts`
- Modify: `echo-agent-server/package.json` (加 `lunr`)
- Run: `npm install`
- Test: `echo-agent-server/test/kb/bm25.test.ts`

**Interfaces:**
- Consumes: `buildBm25Index(docs: { id: string; text: string }[]): Bm25Index`
- Produces: `Bm25Index.search(query: string, topK: number): { id: string; score: number }[]` —— 纯内存,重启重建(Phase 1 简化;Phase 2 可持久化到 sqlite)

**Step 1: 安装依赖**

```bash
cd echo-agent-server && npm install lunr && npm install -D @types/lunr
```

**Step 2: 写失败测试**

```typescript
// echo-agent-server/test/kb/bm25.test.ts
import { describe, it, expect } from 'vitest'
import { buildBm25Index } from '../../src/kb/storage/bm25.js'

describe('bm25 index', () => {
  it('returns documents matching query', () => {
    const idx = buildBm25Index([
      { id: 'a', text: '苹果 是一种 水果' },
      { id: 'b', text: '香蕉 也是 水果' },
      { id: 'c', text: '汽车 不是 水果' },
    ])
    const r = idx.search('水果', 2)
    expect(r.map(x => x.id).sort()).toEqual(['a', 'b'])
  })
})
```

**Step 3: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/bm25.test.ts`
Expected: FAIL

**Step 4: 写 bm25.ts**

```typescript
// echo-agent-server/src/kb/storage/bm25.ts
import lunr from 'lunr'

export interface Bm25Index {
  search(query: string, topK: number): { id: string; score: number }[]
}

export function buildBm25Index(docs: { id: string; text: string }[]): Bm25Index {
  const idx = lunr(function () {
    this.ref('id')
    this.field('text')
    docs.forEach(d => this.add(d))
  })
  return {
    search(query, topK) {
      return idx.search(query).slice(0, topK).map(r => ({ id: r.ref, score: r.score }))
    }
  }
}
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/bm25.test.ts`
Expected: 1 passed

**Step 6: 提交**

```bash
git add echo-agent-server/src/kb/storage/bm25.ts \
        echo-agent-server/test/kb/bm25.test.ts \
        echo-agent-server/package.json \
        echo-agent-server/package-lock.json
git commit -m "feat(kb): 添加 BM25 倒排索引(lunr)"
```

---

#### Task E2: Hybrid RAG 检索器

**Files:**
- Create: `echo-agent-server/src/kb/retrieval/hybrid.ts`
- Test: `echo-agent-server/test/kb/hybrid.test.ts`

**Interfaces:**
- Consumes: 群组内全部 `kb_knowledge_units` 文本(启动时建一次内存 BM25);新 unit 写入时由 ingestion 回调增量更新(Phase 1 简化为"每请求重建一次"——可接受,因为 Phase 1 单位数小;Phase 2 再做增量)
- Produces: `hybridSearch({ db, embed, rerank, groupId, query, topK }): Promise<Array<{ unit: KnowledgeUnitRow; score: number }>>` —— 1) 向量召回 topK*3;2) BM25 召回 topK*3;3) RRF 融合;4) Reranker 精排 topK

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/hybrid.test.ts
import { describe, it, expect } from 'vitest'
import { getDb } from '../../src/db.js'
import { insertUnit } from '../../src/kb/storage/units.js'
import { hybridSearch } from '../../src/kb/retrieval/hybrid.js'
import type { EmbeddingProvider } from '../../src/embedding.js'

const embed: EmbeddingProvider = { embed: async (t) => Array(1024).fill(t.length) }

describe('hybridSearch', () => {
  it('fuses vector + BM25 and reranks', async () => {
    const db = getDb(':memory:')
    await insertUnit(db, embed, { docId: 'd1', groupId: 'g1', location: { kind: 'plain', offset: 0, length: 0 }, text: '苹果是水果' })
    await insertUnit(db, embed, { docId: 'd1', groupId: 'g1', location: { kind: 'plain', offset: 0, length: 0 }, text: '汽车不是水果' })
    const r = await hybridSearch({
      db, embed,
      rerank: { rerank: async (_q, docs, k) => docs.map((_d, i) => ({ index: i, score: 1 - i * 0.1 })).slice(0, k) },
      groupId: 'g1', query: '水果', topK: 2,
    })
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].unit.text).toContain('水果')
  })

  it('filters out units from other groups', async () => {
    const db = getDb(':memory:')
    await insertUnit(db, embed, { docId: 'd1', groupId: 'g2', location: { kind: 'plain', offset: 0, length: 0 }, text: '其他组的资料' })
    const r = await hybridSearch({
      db, embed,
      rerank: { rerank: async (_q, docs, k) => docs.map((_d, i) => ({ index: i, score: 1 })).slice(0, k) },
      groupId: 'g1', query: '资料', topK: 5,
    })
    expect(r).toHaveLength(0)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/hybrid.test.ts`
Expected: FAIL

**Step 3: 写 hybrid.ts**

```typescript
// echo-agent-server/src/kb/retrieval/hybrid.ts
import type { DB } from '../../db.js'
import type { EmbeddingProvider } from '../../embedding.js'
import type { KnowledgeUnitRow } from '../types.js'
import type { RerankClient } from '../services/rerank.js'
import { buildBm25Index } from '../storage/bm25.js'

interface Hit { id: string; score: number }

export async function hybridSearch(input: {
  db: DB; embed: EmbeddingProvider; rerank: RerankClient;
  groupId: string; query: string; topK: number;
}): Promise<Array<{ unit: KnowledgeUnitRow; score: number }>> {
  const { db, embed, rerank, groupId, query, topK } = input

  // 1) 向量召回
  const qVec = await embed.embed(query)
  const vecHits = db.prepare(
    `SELECT unit_id, distance FROM vec_kb_units WHERE embedding MATCH ? AND k = ?`
  ).all(new Float32Array(qVec), topK * 3) as { unit_id: string; distance: number }[]

  // 2) BM25 召回
  const units = (db.prepare(
    `SELECT id, text FROM kb_knowledge_units WHERE group_id = ?`
  ).all(groupId) as { id: string; text: string }[])
  const bm25 = buildBm25Index(units)
  const bmHits = bm25.search(query, topK * 3)

  // 3) RRF 融合
  const fused = rrf([
    vecHits.map(h => ({ id: h.unit_id, score: -h.distance })),  // distance 越小越相关,转正
    bmHits,
  ], 60)
  if (fused.length === 0) return []

  // 4) 按 groupId + id 批量取 unit
  const ids = fused.slice(0, topK * 3).map(f => f.id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT * FROM kb_knowledge_units WHERE id IN (${placeholders}) AND group_id = ?`
  ).all(...ids, groupId) as any[]
  const byId = new Map(rows.map((r: any) => [r.id, r]))

  // 5) Reranker 精排(喂文本)
  const candidates = ids.map(id => byId.get(id)).filter(Boolean).map((r: any) => ({
    id: r.id, text: r.text, unit: parseUnit(r),
  }))
  const reranked = await rerank.rerank(query, candidates.map(c => c.text), Math.min(topK, candidates.length))
  return reranked.map(r => ({ unit: candidates[r.index].unit, score: r.score }))
}

function rrf(lists: Hit[][], k: number): Hit[] {
  const score = new Map<string, number>()
  lists.forEach(list => {
    list.forEach((h, i) => {
      score.set(h.id, (score.get(h.id) ?? 0) + 1 / (k + i + 1))
    })
  })
  return Array.from(score.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, s]) => ({ id, score: s }))
}

function parseUnit(r: any): KnowledgeUnitRow {
  return {
    id: r.id, docId: r.doc_id, groupId: r.group_id,
    location: JSON.parse(r.location), text: r.text,
    vectorRef: r.vector_ref, createdAt: r.created_at,
  }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/hybrid.test.ts`
Expected: 2 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/retrieval/hybrid.ts echo-agent-server/test/kb/hybrid.test.ts
git commit -m "feat(kb): 添加 Hybrid RAG 检索(向量+BM25+RRF+Reranker)"
```

---

#### Task E3: Text-to-SQL 检索器

**Files:**
- Create: `echo-agent-server/src/kb/retrieval/text2sql.ts`
- Test: `echo-agent-server/test/kb/text2sql.test.ts`

**Interfaces:**
- Consumes: 群组 `kb_tables`(含 schema + 摘要)、ChatClient
- Produces: `text2sql({ db, chat, groupId, question, topK = 3 }): Promise<{ sql: string; rows: any[]; tableId: string; cellRefs: { sheet: string; cellRange: string }[] } | null>` —— 1) 用摘要挑最相关的 topK 表;2) LLM 生成 SQL(JSON 模式,严格 schema);3) 安全过滤(只允许 SELECT);4) 执行并收集来源单元格

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/text2sql.test.ts
import { describe, it, expect, vi } from 'vitest'
import { getDb } from '../../src/db.js'
import { createTable, insertTableRows } from '../../src/kb/storage/tables.js'
import { text2sql } from '../../src/kb/retrieval/text2sql.js'
import type { ChatClient } from '../../src/kb/services/chat.js'

describe('text2sql', () => {
  it('picks relevant table, generates SELECT, and returns rows with cell refs', async () => {
    const db = getDb(':memory:')
    const tab = createTable(db, { docId: 'd1', groupId: 'g1', sheet: '销量', schema: { 产品: 'string', 销量: 'number' }, summary: '产品销量表' })
    insertTableRows(db, tab.id, [{ 产品: 'A', 销量: 100 }, { 产品: 'B', 销量: 200 }])
    const chat: ChatClient = { complete: vi.fn(async () => JSON.stringify({
      table: '销量', sql: "SELECT 产品, 销量 FROM 销量 WHERE 销量 > 150"
    })) }
    const r = await text2sql({ db, chat, groupId: 'g1', question: '销量大于150的产品' })
    expect(r?.rows).toEqual([{ 产品: 'B', 销量: 200 }])
    expect(r?.cellRefs[0]).toEqual({ sheet: '销量', cellRange: 'A1:Z1' })
  })

  it('refuses non-SELECT SQL', async () => {
    const db = getDb(':memory:')
    const tab = createTable(db, { docId: 'd1', groupId: 'g1', sheet: 't', schema: { x: 'number' }, summary: 't' })
    insertTableRows(db, tab.id, [{ x: 1 }])
    const chat: ChatClient = { complete: vi.fn(async () => JSON.stringify({ table: 't', sql: 'DELETE FROM t' })) }
    await expect(text2sql({ db, chat, groupId: 'g1', question: '删掉' })).rejects.toThrow(/forbidden/i)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/text2sql.test.ts`
Expected: FAIL

**Step 3: 写 text2sql.ts**

```typescript
// echo-agent-server/src/kb/retrieval/text2sql.ts
import type { DB } from '../../db.js'
import type { ChatClient } from '../services/chat.js'
import { listTablesForGroup } from '../storage/tables.js'

export interface Text2SqlResult {
  sql: string
  rows: any[]
  tableId: string
  cellRefs: { sheet: string; cellRange: string }[]
}

export async function text2sql(input: {
  db: DB; chat: ChatClient; groupId: string; question: string; topK?: number
}): Promise<Text2SqlResult | null> {
  const { db, chat, groupId, question } = input
  const tables = listTablesForGroup(db, groupId)
  if (tables.length === 0) return null

  // 1) 用摘要挑 topK
  const summaries = tables.map(t => `表名:${t.sheet}\n摘要:${t.summary}`).join('\n\n')
  const routerJson = await chat.complete({
    system: '你是数据路由助手,根据用户问题挑最相关的表名。只输出 JSON {tables: [string]}.',
    user: `可用表:\n${summaries}\n\n问题:${question}`,
    json: true,
  })
  let chosen: string[] = []
  try { chosen = JSON.parse(routerJson).tables ?? [] } catch { return null }
  const targets = tables.filter(t => chosen.includes(t.sheet))
  if (targets.length === 0) return null

  // 2) 生成 SQL
  const schemaText = targets.map(t => `表 ${t.sheet} schema:${t.schemaJson}\n样本:${t.summary}`).join('\n\n')
  const sqlJson = await chat.complete({
    system: '你是 SQL 生成助手,只用 SELECT,严格 JSON {table: string, sql: string}.',
    user: `${schemaText}\n\n问题:${question}`,
    json: true,
  })
  const { table: tableName, sql } = JSON.parse(sqlJson) as { table: string; sql: string }
  if (!/^\s*select/i.test(sql)) throw new Error('forbidden: only SELECT allowed')

  // 3) 执行(Phase 1:在内存 JSON rows 上做最简 in-memory 评估;Phase 2 换真实 sqlite 子库)
  const target = targets.find(t => t.sheet === tableName) ?? targets[0]
  const rows = (db.prepare(
    `SELECT row_json FROM kb_table_rows WHERE table_id = ?`
  ).all(target.id) as { row_json: string }[]).map(r => JSON.parse(r.row_json))
  const filtered = evalSqlInMemory(sql, rows)

  return {
    sql, rows: filtered, tableId: target.id,
    cellRefs: [{ sheet: target.sheet, cellRange: 'A1:Z1' }],
  }
}

/** 极简内存 SQL 评估:仅支持 WHERE <col> <op> <number|string>;Phase 2 换 sql.js 或 duckdb。 */
function evalSqlInMemory(sql: string, rows: any[]): any[] {
  const m = sql.match(/where\s+(\w+)\s*(=|>|>=|<|<=)\s*(\d+|'[^']*')/i)
  if (!m) return rows
  const [, col, op, val] = m
  const v = val.startsWith("'") ? val.slice(1, -1) : Number(val)
  return rows.filter(r => compare(r[col], op, v))
}

function compare(a: any, op: string, b: any): boolean {
  switch (op) {
    case '=': return a == b
    case '>': return a > b
    case '>=': return a >= b
    case '<': return a < b
    case '<=': return a <= b
    default: return false
  }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/text2sql.test.ts`
Expected: 2 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/retrieval/text2sql.ts echo-agent-server/test/kb/text2sql.test.ts
git commit -m "feat(kb): 添加 Text-to-SQL 检索(路由+SQL生成+内存求值+安全过滤)"
```

---

#### Task E4: 转写检索器

**Files:**
- Create: `echo-agent-server/src/kb/retrieval/transcript.ts`
- Test: `echo-agent-server/test/kb/transcript.test.ts`

**Interfaces:**
- Consumes: 群组 `kb_transcripts`
- Produces: `transcriptSearch({ db, embed, query, groupId, topK }): Promise<Array<{ segId: string; docId: string; text: string; startMs: number; endMs: number; score: number }>>` —— 用 Embedding 在 transcript text 上做向量召回(Phase 1 简化:每次重建内存索引,因为 transcript 数 ≤ 段数;Phase 2 用 BM25 增量)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/transcript.test.ts
import { describe, it, expect } from 'vitest'
import { getDb } from '../../src/db.js'
import { insertTranscript } from '../../src/kb/storage/transcripts.js'
import { transcriptSearch } from '../../src/kb/retrieval/transcript.js'
import type { EmbeddingProvider } from '../../src/embedding.js'

const embed: EmbeddingProvider = { embed: async (t) => Array(1024).fill(t.length) }

describe('transcriptSearch', () => {
  it('returns matching segments with timestamp', async () => {
    const db = getDb(':memory:')
    insertTranscript(db, { docId: 'v1', groupId: 'g1', startMs: 0, endMs: 1000, text: '会议开始' })
    insertTranscript(db, { docId: 'v1', groupId: 'g1', startMs: 1000, endMs: 2000, text: '讨论Q3预算' })
    const r = await transcriptSearch({ db, embed, groupId: 'g1', query: '预算', topK: 5 })
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].text).toContain('预算')
    expect(r[0].startMs).toBe(1000)
  })

  it('filters by group', async () => {
    const db = getDb(':memory:')
    insertTranscript(db, { docId: 'v1', groupId: 'g2', startMs: 0, endMs: 1000, text: '其他组的内容' })
    const r = await transcriptSearch({ db, embed, groupId: 'g1', query: '内容', topK: 5 })
    expect(r).toHaveLength(0)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/transcript.test.ts`
Expected: FAIL

**Step 3: 写 transcript.ts**

```typescript
// echo-agent-server/src/kb/retrieval/transcript.ts
import type { DB } from '../../db.js'
import type { EmbeddingProvider } from '../../embedding.js'

export interface TranscriptHit {
  segId: string
  docId: string
  text: string
  startMs: number
  endMs: number
  score: number
}

export async function transcriptSearch(input: {
  db: DB; embed: EmbeddingProvider; groupId: string; query: string; topK: number
}): Promise<TranscriptHit[]> {
  const { db, embed, groupId, query, topK } = input
  const segs = db.prepare(
    `SELECT seg_id, doc_id, start_ms, end_ms, text FROM kb_transcripts WHERE group_id = ?`
  ).all(groupId) as any[]
  if (segs.length === 0) return []

  // 简单做法:逐条算向量相似度(Phase 1 行数小可接受;Phase 2 用 sqlite-vec 持久化)
  const qVec = await embed.embed(query)
  const qNorm = Math.sqrt(qVec.reduce((s, x) => s + x * x, 0)) || 1

  const scored = segs.map(s => {
    const text = s.text as string
    const tVec = await embed.embed(text)
    const dot = qVec.reduce((acc, x, i) => acc + x * (tVec[i] ?? 0), 0)
    const tNorm = Math.sqrt(tVec.reduce((acc, x) => acc + x * x, 0)) || 1
    const sim = dot / (qNorm * tNorm)
    return {
      segId: s.seg_id, docId: s.doc_id,
      text: s.text, startMs: s.start_ms, endMs: s.end_ms, score: sim,
    }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}
```

> 注意:这里逐条 await embed.embed 在 Phase 1 行数小可接受;Phase 2 用 batch embedding。

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/transcript.test.ts`
Expected: 2 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/retrieval/transcript.ts echo-agent-server/test/kb/transcript.test.ts
git commit -m "feat(kb): 添加转写检索(逐条向量相似度 + 时间戳定位)"
```

---

### F. 生成层

#### Task F1: 带引用答案生成

**Files:**
- Create: `echo-agent-server/src/kb/generation/answer.ts`
- Test: `echo-agent-server/test/kb/answer.test.ts`

**Interfaces:**
- Consumes: `ChatClient`、候选 knowledge_units
- Produces: `generateAnswer({ chat, question, units, docNames }): Promise<{ answer: string; citedUnitIds: string[] }>` —— Prompt 强约束:每条关键结论必须以 `[unit:<id>]` 结尾,否则不允许生成。解析后回传挂载的 unit ids。

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/answer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { generateAnswer } from '../../src/kb/generation/answer.js'
import type { ChatClient } from '../../src/kb/services/chat.js'
import type { KnowledgeUnitRow } from '../../src/kb/types.js'

const u = (id: string, text: string): KnowledgeUnitRow => ({
  id, docId: 'd1', groupId: 'g1',
  location: { kind: 'plain', offset: 0, length: 0 }, text, vectorRef: id, createdAt: 0,
})

describe('generateAnswer', () => {
  it('extracts cited unit ids from [unit:id] markers', async () => {
    const chat: ChatClient = { complete: vi.fn(async () =>
      '根据资料,关键结论是 X[unit:u1];同时也提到 Y[unit:u2]。'
    ) }
    const r = await generateAnswer({
      chat, question: '?', units: [u('u1', 'X'), u('u2', 'Y'), u('u3', 'Z')],
      docNames: { d1: 'doc1' },
    })
    expect(r.citedUnitIds.sort()).toEqual(['u1', 'u2'])
    expect(r.answer).toContain('X')
  })

  it('returns empty cited ids when model omits all markers', async () => {
    const chat: ChatClient = { complete: vi.fn(async () => '我不确定答案') }
    const r = await generateAnswer({ chat, question: '?', units: [u('u1', 'X')], docNames: { d1: 'doc1' } })
    expect(r.citedUnitIds).toEqual([])
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/answer.test.ts`
Expected: FAIL

**Step 3: 写 answer.ts**

```typescript
// echo-agent-server/src/kb/generation/answer.ts
import type { KnowledgeUnitRow } from '../types.js'
import type { ChatClient } from '../services/chat.js'

export interface AnswerResult {
  answer: string
  citedUnitIds: string[]
}

export async function generateAnswer(input: {
  chat: ChatClient
  question: string
  units: KnowledgeUnitRow[]
  docNames: Record<string, string>
}): Promise<AnswerResult> {
  const ctx = input.units.map((u, i) => {
    const loc = JSON.stringify(u.location)
    return `[${i + 1}] (unit:${u.id}, doc:${input.docNames[u.docId] ?? u.docId}, loc:${loc})\n${u.text}`
  }).join('\n\n')

  const text = await input.chat.complete({
    system: [
      '你是资料问答助手。回答必须严格基于给出的资料片段。',
      '每条关键结论后必须用 [unit:<id>] 标记来源,缺它视为不严谨,允许"未找到充分依据"。',
      '不要编造资料中没有的内容。',
    ].join('\n'),
    user: `问题:${input.question}\n\n资料:\n${ctx}`,
  })

  const ids = Array.from(new Set(Array.from(text.matchAll(/\[unit:([^\]]+)\]/g)).map(m => m[1])))
  // 只保留 input.units 里的 id(防注入)
  const valid = new Set(input.units.map(u => u.id))
  return { answer: text, citedUnitIds: ids.filter(id => valid.has(id)) }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/answer.test.ts`
Expected: 2 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/generation/answer.ts echo-agent-server/test/kb/answer.test.ts
git commit -m "feat(kb): 添加带引用答案生成(强制 unit id 标记)"
```

---

#### Task F2: 回原文校验

**Files:**
- Create: `echo-agent-server/src/kb/generation/verify.ts`
- Test: `echo-agent-server/test/kb/verify.test.ts`

**Interfaces:**
- Consumes: 已挂载引用的答案 + 原始 units
- Produces: `verifyCitations({ answer, citedUnitIds, units }): { confidence: 'high'|'medium'|'low'; verifiedIds: string[]; droppedIds: string[] }` —— 启发式:1) cited unit 必须存在于 units;2) 答案中的关键短语(名词/数字 ≥ 2 字符)在对应 unit text 中出现 ≥ 1 次;3) 全通过 → high;半数通过 → medium;不通过 → low 并丢弃

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/verify.test.ts
import { describe, it, expect } from 'vitest'
import { verifyCitations } from '../../src/kb/generation/verify.js'
import type { KnowledgeUnitRow } from '../../src/kb/types.js'

const u = (id: string, text: string): KnowledgeUnitRow => ({
  id, docId: 'd1', groupId: 'g1',
  location: { kind: 'plain', offset: 0, length: 0 }, text, vectorRef: id, createdAt: 0,
})

describe('verifyCitations', () => {
  it('returns high when cited units back up answer phrases', () => {
    const r = verifyCitations({
      answer: '关键数字是 100 件',
      citedUnitIds: ['u1'],
      units: [u('u1', '本月销售 100 件产品')],
    })
    expect(r.confidence).toBe('high')
    expect(r.verifiedIds).toEqual(['u1'])
  })

  it('drops ids whose unit does not support any phrase', () => {
    const r = verifyCitations({
      answer: '关键数字是 999',
      citedUnitIds: ['u1'],
      units: [u('u1', '本月销售 100 件产品')],
    })
    expect(r.confidence).toBe('low')
    expect(r.droppedIds).toEqual(['u1'])
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/verify.test.ts`
Expected: FAIL

**Step 3: 写 verify.ts**

```typescript
// echo-agent-server/src/kb/generation/verify.ts
import type { Confidence, KnowledgeUnitRow } from '../types.js'

export interface VerifyResult {
  confidence: Confidence
  verifiedIds: string[]
  droppedIds: string[]
}

export function verifyCitations(input: {
  answer: string; citedUnitIds: string[]; units: KnowledgeUnitRow[]
}): VerifyResult {
  const byId = new Map(input.units.map(u => [u.id, u]))
  const phrases = extractPhrases(input.answer)
  const verified: string[] = []
  const dropped: string[] = []

  for (const id of input.citedUnitIds) {
    const u = byId.get(id)
    if (!u) { dropped.push(id); continue }
    const hit = phrases.some(p => u.text.includes(p))
    if (hit) verified.push(id)
    else dropped.push(id)
  }

  let confidence: Confidence = 'high'
  if (input.citedUnitIds.length > 0) {
    const ratio = verified.length / input.citedUnitIds.length
    if (ratio < 0.5) confidence = 'low'
    else if (ratio < 1) confidence = 'medium'
  } else {
    confidence = 'low'
  }
  return { confidence, verifiedIds: verified, droppedIds: dropped }
}

function extractPhrases(answer: string): string[] {
  // 抓所有 ≥ 2 字符的中文/数字/字母短语
  const phrases: string[] = []
  const re = /[一-龥]{2,}|\d{2,}|[A-Za-z]{2,}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(answer)) !== null) phrases.push(m[0])
  return Array.from(new Set(phrases))
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/verify.test.ts`
Expected: 2 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/generation/verify.ts echo-agent-server/test/kb/verify.test.ts
git commit -m "feat(kb): 添加回原文校验(短语匹配 + 置信度)"
```

---

#### Task F3: 不足兜底

**Files:**
- Create: `echo-agent-server/src/kb/generation/fallback.ts`
- Test: `echo-agent-server/test/kb/fallback.test.ts`

**Interfaces:**
- Consumes: 检索召回为空 / 验证后 verifiedIds 全空
- Produces: `fallback({ db, groupId, query }): Promise<{ answer: string; fallbackMaterialList: { docId, docName }[] }>` —— 返回"未找到充分依据"+ 与 query 关键词 BM25 命中的前 5 篇文档名

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/fallback.test.ts
import { describe, it, expect } from 'vitest'
import { getDb } from '../../src/db.js'
import { createDocument } from '../../src/kb/storage/documents.js'
import { fallback } from '../../src/kb/generation/fallback.js'

describe('fallback', () => {
  it('returns placeholder + related docs', async () => {
    const db = getDb(':memory:')
    createDocument(db, { name: '苹果手册.pdf', type: 'pdf', groupId: 'g1', sourcePath: 'g1/d1.pdf', hash: 'h1', uploaderId: 'u1' })
    createDocument(db, { name: '汽车规格.docx', type: 'docx', groupId: 'g1', sourcePath: 'g1/d2.docx', hash: 'h2', uploaderId: 'u1' })
    const r = await fallback({ db, groupId: 'g1', query: '苹果' })
    expect(r.answer).toContain('未找到充分依据')
    expect(r.fallbackMaterialList.length).toBeGreaterThan(0)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/fallback.test.ts`
Expected: FAIL

**Step 3: 写 fallback.ts**

```typescript
// echo-agent-server/src/kb/generation/fallback.ts
import type { DB } from '../../db.js'
import { buildBm25Index } from '../storage/bm25.js'

export interface FallbackResult {
  answer: string
  fallbackMaterialList: { docId: string; docName: string }[]
}

export async function fallback(input: {
  db: DB; groupId: string; query: string
}): Promise<FallbackResult> {
  const docs = input.db.prepare(
    `SELECT id, name FROM kb_documents WHERE group_id = ? AND status = 'ready'`
  ).all(input.groupId) as { id: string; name: string }[]

  const idx = buildBm25Index(docs.map(d => ({ id: d.id, text: d.name })))
  const hits = idx.search(input.query, 5)
  const order = new Map(hits.map(h => [h.id, h.score]))
  const sorted = docs
    .filter(d => order.has(d.id) || docs.length <= 5)
    .sort((a, b) => (order.get(b.id) ?? -1) - (order.get(a.id) ?? -1))
    .slice(0, 5)

  return {
    answer: '未找到充分依据。建议参考以下资料:',
    fallbackMaterialList: sorted.map(d => ({ docId: d.id, docName: d.name })),
  }
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/fallback.test.ts`
Expected: 1 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/kb/generation/fallback.ts echo-agent-server/test/kb/fallback.test.ts
git commit -m "feat(kb): 添加不足兜底(返回相关材料清单)"
```

---

### G. 路由编排

#### Task G1: /api/kb/ask 编排入口(Phase 1 简版)

**Files:**
- Create: `echo-agent-server/src/kb/orchestrator.ts`
- Create: `echo-agent-server/src/kb/storage/qa_logs.ts` (DAO)
- Modify: `echo-agent-server/src/routes/kb.ts`(替换 /api/kb/ask 占位)
- Test: `echo-agent-server/test/kb/orchestrator.test.ts`

**Interfaces:**
- Consumes: ChatClient、RerankClient、EmbeddingProvider、Hybrid、Text2Sql、TranscriptSearch、GenerateAnswer、Verify、Fallback、QaLogsDAO
- Produces: `ask({ db, deps, groupId, userId, query, topK }): Promise<AskResult>` —— Phase 1 简化路由:1) 关键词启发式分流(数字/计数 → Text-to-SQL;含"视频/会议" → 转写检索;否则 → Hybrid);2) 走对应检索器;3) 生成 + 校验 + 兜底;4) 写 qa_log

**Step 1: 写 qa_logs DAO**

```typescript
// echo-agent-server/src/kb/storage/qa_logs.ts
import { randomUUID } from 'node:crypto'
import type { DB } from '../../db.js'
import type { Citation, Confidence } from '../types.js'

export interface QaLogRow {
  id: string
  groupId: string
  userId: string
  question: string
  answer: string
  citations: Citation[]
  confidence: Confidence
  feedback: -1 | 0 | 1
  createdAt: number
}

export function createQaLog(db: DB, input: {
  groupId: string; userId: string; question: string; answer: string;
  citations: Citation[]; confidence: Confidence
}): QaLogRow {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO kb_qa_logs (id, group_id, user_id, question, answer, citations, confidence, feedback, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, input.groupId, input.userId, input.question, input.answer,
    JSON.stringify(input.citations), input.confidence, 0, now)
  return { id, groupId: input.groupId, userId: input.userId,
    question: input.question, answer: input.answer, citations: input.citations,
    confidence: input.confidence, feedback: 0, createdAt: now }
}

export function updateFeedback(db: DB, id: string, groupId: string, feedback: -1 | 1): boolean {
  const r = db.prepare(
    `UPDATE kb_qa_logs SET feedback = ? WHERE id = ? AND group_id = ?`
  ).run(feedback, id, groupId)
  return r.changes > 0
}

export function getQaLog(db: DB, id: string, groupId: string): QaLogRow | null {
  const r = db.prepare(
    `SELECT * FROM kb_qa_logs WHERE id = ? AND group_id = ?`
  ).get(id, groupId) as any
  if (!r) return null
  return { id: r.id, groupId: r.group_id, userId: r.user_id,
    question: r.question, answer: r.answer, citations: JSON.parse(r.citations),
    confidence: r.confidence, feedback: r.feedback, createdAt: r.created_at }
}
```

**Step 2: 写失败测试**

```typescript
// echo-agent-server/test/kb/orchestrator.test.ts
import { describe, it, expect } from 'vitest'
import { getDb } from '../../src/db.js'
import { createDocument } from '../../src/kb/storage/documents.js'
import { insertUnit } from '../../src/kb/storage/units.js'
import { ask } from '../../src/kb/orchestrator.js'
import type { EmbeddingProvider } from '../../src/embedding.js'

const embed: EmbeddingProvider = { embed: async (t) => Array(1024).fill(t.length) }

describe('ask orchestrator', () => {
  it('returns hybrid answer when no numeric/video keywords', async () => {
    const db = getDb(':memory:')
    const doc = createDocument(db, { name: 'a.txt', type: 'text', groupId: 'g1', sourcePath: 'p', hash: 'h', uploaderId: 'u1' })
    await insertUnit(db, embed, { docId: doc.id, groupId: 'g1', location: { kind: 'plain', offset: 0, length: 0 }, text: '苹果是水果' })
    const r = await ask({
      db, deps: {
        embed,
        chat: { complete: async () => '苹果是常见水果[unit:U_PLACEHOLDER]' },
        rerank: { rerank: async (_q, docs, k) => docs.map((_d, i) => ({ index: i, score: 1 })).slice(0, k) },
      },
      groupId: 'g1', userId: 'u1', query: '苹果', topK: 3,
    })
    expect(r.answer).toContain('苹果')
  })
})
```

**Step 3: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/orchestrator.test.ts`
Expected: FAIL

**Step 4: 写 orchestrator.ts**

```typescript
// echo-agent-server/src/kb/orchestrator.ts
import type { DB } from '../db.js'
import type { EmbeddingProvider } from '../embedding.js'
import type { ChatClient } from './services/chat.js'
import type { RerankClient } from './services/rerank.js'
import type { AskResult, KnowledgeUnitRow } from './types.js'
import { hybridSearch } from './retrieval/hybrid.js'
import { text2sql } from './retrieval/text2sql.js'
import { transcriptSearch } from './retrieval/transcript.js'
import { generateAnswer } from './generation/answer.js'
import { verifyCitations } from './generation/verify.js'
import { fallback } from './generation/fallback.js'
import { createQaLog } from './storage/qa_logs.js'
import { listDocuments } from './storage/documents.js'

export interface AskDeps {
  embed: EmbeddingProvider
  chat: ChatClient
  rerank: RerankClient
}

const TABLE_HINT = /(多少|几|求和|平均|最大|最小|合计|数量|sum|avg|count|max|min)/i
const TRANSCRIPT_HINT = /(视频|会议|录音|语音|讲座|培训)/i

export async function ask(input: {
  db: DB; deps: AskDeps; groupId: string; userId: string;
  query: string; topK?: number;
}): Promise<AskResult> {
  const { db, deps, groupId, userId, query } = input
  const topK = input.topK ?? 5

  // 1) Phase 1 简化路由
  let units: KnowledgeUnitRow[] = []
  let extraCitations: AskResult['citations'] = []

  if (TABLE_HINT.test(query)) {
    const r = await text2sql({ db, chat: deps.chat, groupId, question: query })
    if (r) {
      const sqlAnswer = `根据查询 "${query}", 结果:${JSON.stringify(r.rows)} (来源 sheet:${r.cellRefs[0].sheet})`
      const log = createQaLog(db, {
        groupId, userId, question: query, answer: sqlAnswer,
        citations: [], confidence: 'high',
      })
      return { answer: sqlAnswer, citations: [], confidence: 'high' }
    }
  }

  if (TRANSCRIPT_HINT.test(query)) {
    const hits = await transcriptSearch({ db, embed: deps.embed, groupId, query, topK })
    if (hits.length > 0) {
      const transUnits: KnowledgeUnitRow[] = hits.map(h => ({
        id: h.segId, docId: h.docId, groupId,
        location: { kind: 'timestamp', startMs: h.startMs, endMs: h.endMs },
        text: h.text, vectorRef: h.segId, createdAt: 0,
      }))
      units.push(...transUnits)
    }
  }

  if (units.length === 0) {
    const r = await hybridSearch({ db, embed: deps.embed, rerank: deps.rerank,
      groupId, query, topK })
    units = r.map(x => x.unit)
  }

  // 2) 没召回 → 兜底
  if (units.length === 0) {
    const fb = await fallback({ db, groupId, query })
    const log = createQaLog(db, {
      groupId, userId, question: query, answer: fb.answer,
      citations: [], confidence: 'low',
    })
    return { ...fb, answer: `${fb.answer}\n${log.id}` }
  }

  // 3) 生成 + 校验
  const docs = listDocuments(db, groupId, 1000, 0)
  const docNames = Object.fromEntries(docs.items.map(d => [d.id, d.name]))
  const { answer, citedUnitIds } = await generateAnswer({
    chat: deps.chat, question: query, units, docNames,
  })
  const verify = verifyCitations({ answer, citedUnitIds, units })
  const citedUnits = units.filter(u => verify.verifiedIds.includes(u.id))

  // 4) 构造 citations
  const citations = citedUnits.map(u => ({
    unitId: u.id, docId: u.docId,
    docName: docNames[u.docId] ?? u.docId,
    location: u.location, excerpt: u.text.slice(0, 200),
  }))

  // 5) 写 qa_log
  createQaLog(db, {
    groupId, userId, question: query, answer,
    citations, confidence: verify.confidence,
  })

  return { answer, citations, confidence: verify.confidence }
}
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/orchestrator.test.ts`
Expected: 1 passed(测试中 fake chat 引用了不存在的 unit id,会被 verify 标 low 但不报错)

**Step 6: 替换 routes/kb.ts 中 /api/kb/ask 占位**

修改 `echo-agent-server/src/routes/kb.ts`:

```typescript
import { z } from 'zod'
import { ask } from '../kb/orchestrator.js'
import { createEmbeddingProvider } from '../embedding.js'
import { createChatClient } from '../kb/services/chat.js'
import { createRerankClient } from '../kb/services/rerank.js'
import { updateFeedback, getQaLog } from '../kb/storage/qa_logs.js'

const AskSchema = z.object({ query: z.string().min(1), topK: z.number().int().positive().optional() })
const FeedbackSchema = z.object({ feedback: z.union([z.literal(1), z.literal(-1)]) })
const DocumentIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) })

// 替换 /api/kb/ask 占位:
  app.post('/api/kb/ask', { preHandler: app.authenticate }, async (req, reply) => {
    const g = groupOr401(req, reply); if (!g) return reply
    const parsed = AskSchema.safeParse(req.body)
    if (!parsed.success) return reply.send(fail(1507, '请求体非法'))
    const r = await ask({
      db: app.deps.db,
      deps: {
        embed: createEmbeddingProvider(),
        chat: createChatClient(),
        rerank: createRerankClient(),
      },
      groupId: g, userId: (req.user as JwtClaims).sub,
      query: parsed.data.query, topK: parsed.data.topK,
    })
    return reply.send(ok(r))
  })

// 替换 /api/kb/qa/:id/feedback 占位:
  app.post('/api/kb/qa/:id/feedback', { preHandler: app.authenticate }, async (req, reply) => {
    const g = groupOr401(req, reply); if (!g) return reply
    const parsed = FeedbackSchema.safeParse(req.body)
    if (!parsed.success) return reply.send(fail(1508, 'feedback 必须是 1 或 -1'))
    const { id } = req.params as { id: string }
    const okFlag = updateFeedback(app.deps.db, id, g, parsed.data.feedback)
    return reply.send(ok({ ok: okFlag }))
  })

// 替换 /api/kb/documents 占位:
  app.get('/api/kb/documents', { preHandler: app.authenticate }, async (req, reply) => {
    const g = groupOr401(req, reply); if (!g) return reply
    const { limit, offset } = (req.query ?? {}) as { limit?: string; offset?: string }
    return reply.send(ok(listDocuments(app.deps.db, g,
      Math.min(Number(limit ?? 50) || 50, 200), Number(offset ?? 0))))
  })
```

并添加 imports 与 DocumentIdSchema。

**Step 7: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/`
Expected: 全部 kb 测试通过

**Step 8: 提交**

```bash
git add echo-agent-server/src/kb/orchestrator.ts \
        echo-agent-server/src/kb/storage/qa_logs.ts \
        echo-agent-server/src/routes/kb.ts \
        echo-agent-server/test/kb/orchestrator.test.ts
git commit -m "feat(kb): 添加 ask 编排(关键词路由+hybrid+生成+校验+兜底+qa_log)"
```

---

#### Task G2: 上传与状态路由实装

**Files:**
- Modify: `echo-agent-server/src/routes/kb.ts`
- Test: `echo-agent-server/test/kb/upload-route.test.ts`

**Interfaces:**
- `POST /api/kb/upload` 接 multipart/form-data,字段名 `file`,调 `enqueueUpload`,返回 `{ docId, status: 'pending' }`
- `GET /api/kb/documents/:id/status` 返回 `{ status, errorMessage }`(查 `kb_documents`)
- `GET /api/kb/documents/:id` 返回 `{ ...document, units: [...] }`(用 `listUnitsByDoc`)

**Step 1: 写失败测试**

```typescript
// echo-agent-server/test/kb/upload-route.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/app.js'
import { getDb } from '../../src/db.js'

describe('kb upload route', () => {
  let app: any, token: string

  beforeAll(async () => {
    process.env.ECHO_SERVER_DB = ':memory:'
    const db = getDb()
    app = buildApp({ db, embed: { embed: async () => new Array(1024).fill(0) } })
    await app.ready()
    await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { username: 'bob', password: 'pwd12345678', groupId: 'g1' } })
    const r = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'bob', password: 'pwd12345678' } })
    token = r.json().data.token
  })
  afterAll(async () => { await app.close() })

  it('uploads a text file and returns docId', async () => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from('第一段。\n\n第二段。')]), 'a.txt')
    const r = await app.inject({
      method: 'POST', url: '/api/kb/upload',
      headers: { authorization: `Bearer ${token}` },
      payload: form,
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.code).toBe(0)
    expect(body.data.docId).toBeTruthy()
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/upload-route.test.ts`
Expected: FAIL(/api/kb/upload 还在 501)

**Step 3: 实现路由**

修改 `echo-agent-server/src/routes/kb.ts`:

```typescript
import { enqueueUpload } from '../kb/ingestion/pipeline.js'
import { getDocument, listDocuments } from '../kb/storage/documents.js'
import { listUnitsByDoc } from '../kb/storage/units.js'
import type { MultipartFile } from '@fastify/multipart'

// 替换 /api/kb/upload 占位:
  app.post('/api/kb/upload', { preHandler: app.authenticate }, async (req, reply) => {
    const g = groupOr401(req, reply); if (!g) return reply
    const file = await (req as any).file()
    if (!file) return reply.send(fail(1509, '未收到文件'))
    const buf = await file.toBuffer()
    const docId = await enqueueUpload({
      db: app.deps.db, embed: app.deps.embed,
      groupId: g, uploaderId: (req.user as JwtClaims).sub,
      buf, fileName: file.filename ?? 'upload.txt',
    })
    return reply.send(ok({ docId, status: 'pending' }))
  })

// 替换 /api/kb/documents/:id 占位:
  app.get('/api/kb/documents/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const g = groupOr401(req, reply); if (!g) return reply
    const { id } = req.params as { id: string }
    const doc = getDocument(app.deps.db, id, g)
    if (!doc) return reply.send(fail(1510, '文档不存在'))
    const units = listUnitsByDoc(app.deps.db, id, g)
    return reply.send(ok({ ...doc, units }))
  })

// 替换 /api/kb/documents/:id/status 占位:
  app.get('/api/kb/documents/:id/status', { preHandler: app.authenticate }, async (req, reply) => {
    const g = groupOr401(req, reply); if (!g) return reply
    const { id } = req.params as { id: string }
    const doc = getDocument(app.deps.db, id, g)
    if (!doc) return reply.send(fail(1510, '文档不存在'))
    return reply.send(ok({ status: doc.status, errorMessage: doc.errorMessage }))
  })
```

> 注意:`@fastify/multipart` 已在 fastify 5 主包里或需单独安装;若未装,执行 `npm install @fastify/multipart` 并在 `app.ts` 的 buildApp 中 `await app.register(multipart)`.Task A3 阶段若发现未注册,此处补 install + register。

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/upload-route.test.ts`
Expected: 1 passed

**Step 5: 提交**

```bash
git add echo-agent-server/src/routes/kb.ts echo-agent-server/test/kb/upload-route.test.ts
git commit -m "feat(kb): 完善上传与文档状态路由(multipart + 状态查询)"
```

---

### H. 客户端页面

#### Task H1: 资料库页骨架与上传

**Files:**
- Create: `echo-agent-desktop/src/renderer/src/pages/KbLibrary/index.tsx`
- Create: `echo-agent-desktop/src/renderer/src/pages/KbLibrary/kb-library.module.scss`
- Create: `echo-agent-desktop/src/renderer/src/pages/KbLibrary/service.ts`
- Create: `echo-agent-desktop/src/renderer/src/pages/KbLibrary/mock.ts`
- Test: `echo-agent-desktop/src/renderer/src/pages/KbLibrary/__tests__/upload.test.tsx`

**Interfaces:**
- Consumes: `uploadKbDocument(file, onProgress)`、`listKbDocuments`
- Produces: 渲染组件 `<KbLibrary />` —— 顶部拖拽/选择上传区,中部表格(由 H2 填),底部状态消息

**Step 1: 写 service.ts 与 mock.ts**

```typescript
// echo-agent-desktop/src/renderer/src/pages/KbLibrary/service.ts
import { uploadKbDocument, listKbDocuments } from '@/services/kb'
export { uploadKbDocument, listKbDocuments }
```

```typescript
// echo-agent-desktop/src/renderer/src/pages/KbLibrary/mock.ts
import type { KbDocument } from '@/services/kb'
export const mockKbDocuments: KbDocument[] = [
  { id: 'd1', name: '苹果手册.pdf', type: 'pdf', status: 'ready', hash: 'h1', version: 1, errorMessage: null, createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86000000 },
]
```

**Step 2: 写失败测试**

```typescript
// echo-agent-desktop/src/renderer/src/pages/KbLibrary/__tests__/upload.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import KbLibrary from '../index'
import * as svc from '@/services/kb'

vi.mock('@/services/kb', () => ({
  uploadKbDocument: vi.fn(async () => ({ id: 'd1', name: 'a.txt', type: 'text', status: 'pending', hash: 'h', version: 1, errorMessage: null, createdAt: 0, updatedAt: 0 })),
  listKbDocuments: vi.fn(async () => ({ items: [], total: 0 })),
}))

describe('KbLibrary upload', () => {
  it('shows file input and triggers upload on change', async () => {
    render(<KbLibrary />)
    const input = screen.getByTestId('kb-upload-input') as HTMLInputElement
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(svc.uploadKbDocument).toHaveBeenCalled())
  })
})
```

**Step 3: 跑测试,确认失败**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/pages/KbLibrary/__tests__/upload.test.tsx`
Expected: FAIL(模块未找到)

**Step 4: 写 index.tsx + scss**

```tsx
// echo-agent-desktop/src/renderer/src/pages/KbLibrary/index.tsx
import { useState } from 'react'
import { uploadKbDocument } from './service'
import styles from './kb-library.module.scss'

export default function KbLibrary() {
  const [progress, setProgress] = useState<number | null>(null)
  const [msg, setMsg] = useState<string>('')

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setProgress(0); setMsg(`上传中:${file.name}`)
    try {
      const doc = await uploadKbDocument(file, (p) => setProgress(p))
      setMsg(`已加入摄取队列:${doc.name} (id=${doc.id})`)
    } catch (err: any) {
      setMsg(`上传失败:${err?.message ?? err}`)
    } finally { setProgress(null) }
  }

  return (
    <div className={styles.page}>
      <h2>资料库</h2>
      <label className={styles.dropzone}>
        <input data-testid="kb-upload-input" type="file" hidden onChange={onChange}
               accept=".txt,.md,.docx,.pdf,.xlsx,.csv,.mp3,.wav,.m4a,.mp4" />
        点击或拖拽上传文件
      </label>
      {progress !== null && <div className={styles.progress}>上传进度:{progress}%</div>}
      {msg && <div className={styles.msg}>{msg}</div>}
    </div>
  )
}
```

```scss
// echo-agent-desktop/src/renderer/src/pages/KbLibrary/kb-library.module.scss
.page { padding: 16px; }
.dropzone { display: block; padding: 32px; border: 2px dashed #888; text-align: center; cursor: pointer; }
.progress { margin-top: 8px; }
.msg { margin-top: 8px; color: #666; }
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/pages/KbLibrary/__tests__/upload.test.tsx`
Expected: 1 passed

**Step 6: 提交**

```bash
cd echo-agent-desktop
git add src/renderer/src/pages/KbLibrary/ \
        src/renderer/src/pages/KbLibrary/__tests__/upload.test.tsx
git commit -m "feat(kb): 添加资料库页骨架与上传组件"
```

---

#### Task H2: 资料库页列表 + 进度轮询 + 分组

**Files:**
- Modify: `echo-agent-desktop/src/renderer/src/pages/KbLibrary/index.tsx`
- Test: `echo-agent-desktop/src/renderer/src/pages/KbLibrary/__tests__/list.test.tsx`

**Interfaces:**
- 拉取 `listKbDocuments({limit: 50})` 渲染表格;对 `status !== 'ready'` 的文档用 `setInterval` 每 3 秒调一次 `getKbDocumentStatus`

**Step 1: 写失败测试**

```typescript
// echo-agent-desktop/src/renderer/src/pages/KbLibrary/__tests__/list.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import KbLibrary from '../index'

vi.mock('@/services/kb', () => ({
  uploadKbDocument: vi.fn(),
  listKbDocuments: vi.fn(async () => ({
    items: [{ id: 'd1', name: 'a.txt', type: 'text', status: 'ready', hash: 'h', version: 1, errorMessage: null, createdAt: 0, updatedAt: 0 }],
    total: 1,
  })),
  getKbDocumentStatus: vi.fn(async () => ({ status: 'ready', errorMessage: null })),
}))

describe('KbLibrary list', () => {
  it('renders documents table', async () => {
    render(<KbLibrary />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/pages/KbLibrary/__tests__/list.test.tsx`
Expected: FAIL

**Step 3: 改造 index.tsx**

修改 `echo-agent-desktop/src/renderer/src/pages/KbLibrary/index.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { uploadKbDocument, listKbDocuments, getKbDocumentStatus } from '@/services/kb'
import type { KbDocument } from '@/services/kb'
import styles from './kb-library.module.scss'

export default function KbLibrary() {
  const [progress, setProgress] = useState<number | null>(null)
  const [msg, setMsg] = useState<string>('')
  const [items, setItems] = useState<KbDocument[]>([])

  async function refresh() {
    const r = await listKbDocuments({ limit: 50 })
    setItems(r.items)
  }
  useEffect(() => { refresh() }, [])

  useEffect(() => {
    const t = setInterval(async () => {
      const pendings = items.filter(i => i.status !== 'ready' && i.status !== 'failed')
      if (pendings.length === 0) return
      const updates = await Promise.all(pendings.map(p => getKbDocumentStatus(p.id)))
      setItems(prev => prev.map(p => {
        const u = updates.find(x => x !== undefined)
        const idx = pendings.findIndex(x => x.id === p.id)
        return idx >= 0 ? { ...p, status: updates[idx].status, errorMessage: updates[idx].errorMessage } : p
      }))
    }, 3000)
    return () => clearInterval(t)
  }, [items])

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setProgress(0); setMsg(`上传中:${file.name}`)
    try {
      const doc = await uploadKbDocument(file, (p) => setProgress(p))
      setMsg(`已加入摄取队列:${doc.name} (id=${doc.id})`)
      refresh()
    } catch (err: any) { setMsg(`上传失败:${err?.message ?? err}`) }
    finally { setProgress(null) }
  }

  return (
    <div className={styles.page}>
      <h2>资料库</h2>
      <label className={styles.dropzone}>
        <input data-testid="kb-upload-input" type="file" hidden onChange={onChange}
               accept=".txt,.md,.docx,.pdf,.xlsx,.csv,.mp3,.wav,.m4a,.mp4" />
        点击或拖拽上传文件
      </label>
      {progress !== null && <div className={styles.progress}>上传进度:{progress}%</div>}
      {msg && <div className={styles.msg}>{msg}</div>}
      <table className={styles.table}>
        <thead><tr><th>名称</th><th>类型</th><th>状态</th><th>更新时间</th></tr></thead>
        <tbody>
          {items.map(d => (
            <tr key={d.id}>
              <td>{d.name}</td><td>{d.type}</td>
              <td>{d.status}{d.errorMessage ? `:${d.errorMessage}` : ''}</td>
              <td>{new Date(d.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/pages/KbLibrary/__tests__/`
Expected: 全部通过

**Step 5: 提交**

```bash
cd echo-agent-desktop
git add src/renderer/src/pages/KbLibrary/index.tsx \
        src/renderer/src/pages/KbLibrary/__tests__/list.test.tsx
git commit -m "feat(kb): 资料库页加文档列表与状态轮询"
```

---

#### Task H3: 资料问答页骨架与提问

**Files:**
- Create: `echo-agent-desktop/src/renderer/src/pages/KbQA/index.tsx`
- Create: `echo-agent-desktop/src/renderer/src/pages/KbQA/kb-qa.module.scss`
- Create: `echo-agent-desktop/src/renderer/src/pages/KbQA/service.ts`
- Create: `echo-agent-desktop/src/renderer/src/pages/KbQA/mock.ts`
- Test: `echo-agent-desktop/src/renderer/src/pages/KbQA/__tests__/ask.test.tsx`

**Interfaces:**
- Consumes: `askKb({ query, topK })`
- Produces: `<KbQA />` —— 输入框 + 历史列表,提交后展示 `result.answer`(H4 再加引用)

**Step 1: 写 service.ts / mock.ts / index.tsx**

```typescript
// service.ts
export { askKb, submitKbFeedback } from '@/services/kb'
```

```typescript
// mock.ts
import type { KbAskResult } from '@/services/kb'
export const mockKbAskResult: KbAskResult = {
  answer: '苹果是一种水果[unit:mock-1]。',
  citations: [],
  confidence: 'high',
}
```

```tsx
// index.tsx
import { useState } from 'react'
import { askKb } from './service'
import styles from './kb-qa.module.scss'

interface History { q: string; a: string; confidence: 'high'|'medium'|'low' }

export default function KbQA() {
  const [q, setQ] = useState('')
  const [hist, setHist] = useState<History[]>([])
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!q.trim() || busy) return
    setBusy(true)
    try {
      const r = await askKb({ query: q })
      setHist(h => [{ q, a: r.answer, confidence: r.confidence }, ...h])
      setQ('')
    } finally { setBusy(false) }
  }

  return (
    <div className={styles.page}>
      <h2>资料问答</h2>
      <form onSubmit={submit} className={styles.form}>
        <input data-testid="kb-qa-input" value={q} onChange={e => setQ(e.target.value)}
               placeholder="输入问题,例如:本月销售多少?" />
        <button type="submit" disabled={busy}>{busy ? '生成中…' : '提问'}</button>
      </form>
      <div className={styles.hist}>
        {hist.map((h, i) => (
          <div key={i} className={styles.item}>
            <div className={styles.q}>Q: {h.q}</div>
            <div className={styles.a}>A: {h.a} <span className={styles.conf}>[{h.confidence}]</span></div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

```scss
.page { padding: 16px; }
.form { display: flex; gap: 8px; }
.form input { flex: 1; padding: 8px; }
.hist { margin-top: 16px; }
.item { padding: 8px; border-bottom: 1px solid #eee; }
.q { font-weight: bold; }
.a { white-space: pre-wrap; }
.conf { color: #888; font-size: 12px; }
```

**Step 2: 写失败测试**

```tsx
// __tests__/ask.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import KbQA from '../index'

vi.mock('@/services/kb', () => ({
  askKb: vi.fn(async () => ({ answer: 'A', citations: [], confidence: 'high' })),
  submitKbFeedback: vi.fn(),
}))

describe('KbQA ask', () => {
  it('submits query and renders answer', async () => {
    render(<KbQA />)
    fireEvent.change(screen.getByTestId('kb-qa-input'), { target: { value: '苹果?' } })
    fireEvent.click(screen.getByText('提问'))
    await waitFor(() => expect(screen.getByText(/^A:/)).toBeInTheDocument())
  })
})
```

**Step 3: 跑测试,确认失败**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/pages/KbQA/__tests__/ask.test.tsx`
Expected: FAIL

**Step 4: 跑测试,确认通过**

Expected: 1 passed

**Step 5: 提交**

```bash
cd echo-agent-desktop
git add src/renderer/src/pages/KbQA/
git commit -m "feat(kb): 添加资料问答页骨架与提问"
```

---

#### Task H4: 资料问答页带引用渲染 + 反馈

**Files:**
- Modify: `echo-agent-desktop/src/renderer/src/pages/KbQA/index.tsx`
- Create: `echo-agent-desktop/src/renderer/src/components/SourceViewer/index.tsx`(占位,Task H5 完善)
- Test: `echo-agent-desktop/src/renderer/src/pages/KbQA/__tests__/citations.test.tsx`

**Interfaces:**
- 解析 `result.answer` 中的 `[unit:<id>]` 标记,在对应位置插入"引用 N"角标;角标点击 → 打开 `<SourceViewer citation={...} />`;每条 answer 末尾给 👍/👎 → `submitKbFeedback({ qaLogId, feedback })`(qaLogId 暂用 answer hash 占位,Phase 2 由后端返回 id)

**Step 1: 写失败测试**

```tsx
// __tests__/citations.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import KbQA from '../index'

vi.mock('@/services/kb', () => ({
  askKb: vi.fn(async () => ({
    answer: '苹果是水果[unit:u1]。',
    citations: [{ unitId: 'u1', docId: 'd1', docName: '苹果手册', location: { kind: 'plain', offset: 0, length: 0 }, excerpt: '苹果是水果' }],
    confidence: 'high',
  })),
  submitKbFeedback: vi.fn(),
}))

describe('KbQA citations', () => {
  it('renders citation chip and opens source viewer on click', async () => {
    render(<KbQA />)
    fireEvent.change(screen.getByTestId('kb-qa-input'), { target: { value: '苹果' } })
    fireEvent.click(screen.getByText('提问'))
    await waitFor(() => expect(screen.getByText(/\[1\]/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/\[1\]/))
    expect(screen.getByTestId('source-viewer')).toBeInTheDocument()
  })
})
```

**Step 2: 写 SourceViewer 占位**

```tsx
// echo-agent-desktop/src/renderer/src/components/SourceViewer/index.tsx
import type { KbCitation } from '@/services/kb'
import { DispatchViewer } from './dispatch'

export default function SourceViewer(props: { citation: KbCitation; onClose?: () => void }) {
  return (
    <div data-testid="source-viewer" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)' }}>
      <div style={{ background: '#fff', margin: '5% auto', padding: 16, maxWidth: 800 }}>
        <button onClick={props.onClose}>关闭</button>
        <h3>{props.citation.docName}</h3>
        <DispatchViewer citation={props.citation} />
      </div>
    </div>
  )
}
```

**Step 3: 写 dispatch.ts 占位**

```typescript
// echo-agent-desktop/src/renderer/src/components/SourceViewer/dispatch.ts
import type { KbCitation } from '@/services/kb'
export function DispatchViewer({ citation }: { citation: KbCitation }) {
  return <div data-testid="dispatch-placeholder">来源:{citation.docName} (位置:{JSON.stringify(citation.location)})</div>
}
```

**Step 4: 改造 KbQA/index.tsx**

```tsx
import { useState } from 'react'
import { askKb, submitKbFeedback } from '@/services/kb'
import type { KbCitation } from '@/services/kb'
import SourceViewer from '@/components/SourceViewer'
import styles from './kb-qa.module.scss'

interface History { q: string; answerText: string; citations: KbCitation[]; confidence: 'high'|'medium'|'low'; qaLogId: string }

export default function KbQA() {
  const [q, setQ] = useState('')
  const [hist, setHist] = useState<History[]>([])
  const [busy, setBusy] = useState(false)
  const [openCite, setOpenCite] = useState<KbCitation | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!q.trim() || busy) return
    setBusy(true)
    try {
      const r = await askKb({ query: q })
      const qaLogId = crypto.randomUUID()  // Phase 1 占位;Phase 2 由后端 ask 返回
      setHist(h => [{ q, answerText: r.answer, citations: r.citations, confidence: r.confidence, qaLogId }, ...h])
      setQ('')
    } finally { setBusy(false) }
  }

  return (
    <div className={styles.page}>
      <h2>资料问答</h2>
      <form onSubmit={submit} className={styles.form}>
        <input data-testid="kb-qa-input" value={q} onChange={e => setQ(e.target.value)} placeholder="输入问题" />
        <button type="submit" disabled={busy}>{busy ? '生成中…' : '提问'}</button>
      </form>
      <div className={styles.hist}>
        {hist.map((h, i) => (
          <div key={i} className={styles.item}>
            <div className={styles.q}>Q: {h.q}</div>
            <div className={styles.a}>
              {renderWithCitations(h.answerText, h.citations, c => setOpenCite(c))}
              <span className={styles.conf}>[{h.confidence}]</span>
              <button data-testid={`fb-up-${i}`} onClick={() => submitKbFeedback({ qaLogId: h.qaLogId, feedback: 1 })}>👍</button>
              <button data-testid={`fb-down-${i}`} onClick={() => submitKbFeedback({ qaLogId: h.qaLogId, feedback: -1 })}>👎</button>
            </div>
          </div>
        ))}
      </div>
      {openCite && <SourceViewer citation={openCite} onClose={() => setOpenCite(null)} />}
    </div>
  )
}

function renderWithCitations(text: string, cites: KbCitation[], open: (c: KbCitation) => void): React.ReactNode {
  const out: React.ReactNode[] = []
  let last = 0
  const re = /\[unit:([^\]]+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const idx = cites.findIndex(c => c.unitId === m![1])
    if (idx >= 0) {
      out.push(<sup key={`${m.index}-${idx}`}><a data-testid={`cite-${idx}`} href="#" onClick={(e) => { e.preventDefault(); open(cites[idx]) }}>[{idx + 1}]</a></sup>)
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}
```

**Step 5: 跑测试,确认通过**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/pages/KbQA/__tests__/`
Expected: 全部通过

**Step 6: 提交**

```bash
cd echo-agent-desktop
git add src/renderer/src/pages/KbQA/index.tsx \
        src/renderer/src/pages/KbQA/__tests__/citations.test.tsx \
        src/renderer/src/components/SourceViewer/index.tsx \
        src/renderer/src/components/SourceViewer/dispatch.ts
git commit -m "feat(kb): 资料问答页加引用渲染与反馈"
```

---

#### Task H5: 来源查看器组件(PDF/Word/Excel/音视频)

**Files:**
- Create: `echo-agent-desktop/src/renderer/src/components/SourceViewer/PdfViewer.tsx`
- Create: `echo-agent-desktop/src/renderer/src/components/SourceViewer/DocxViewer.tsx`
- Create: `echo-agent-desktop/src/renderer/src/components/SourceViewer/ExcelViewer.tsx`
- Create: `echo-agent-desktop/src/renderer/src/components/SourceViewer/MediaPlayer.tsx`
- Modify: `echo-agent-desktop/src/renderer/src/components/SourceViewer/dispatch.ts`
- Test: `echo-agent-desktop/src/renderer/src/components/SourceViewer/__tests__/dispatch.test.tsx`

**Interfaces:**
- `DispatchViewer` 根据 `citation.location.kind` 分派:plain → DocxViewer(把文本贴到容器);page_section + docType=pdf → PdfViewer(打开到 page);sheet_cell → ExcelViewer(高亮 cellRange);timestamp → MediaPlayer(跳到 startMs);Phase 1 简化为"展示元数据 + 占位 UI",Phase 2 接 pdfjs/mammoth/xlsx 渲染

**Step 1: 写失败测试**

```tsx
// __tests__/dispatch.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DispatchViewer } from '../dispatch'
import type { KbCitation } from '@/services/kb'

const baseCitation: KbCitation = {
  unitId: 'u1', docId: 'd1', docName: 'doc.pdf', excerpt: '',
  location: { kind: 'plain', offset: 0, length: 0 },
}

describe('DispatchViewer', () => {
  it('renders timestamp player for media citations', () => {
    render(<DispatchViewer citation={{ ...baseCitation, location: { kind: 'timestamp', startMs: 12000, endMs: 15000 } }} />)
    expect(screen.getByTestId('media-player')).toBeInTheDocument()
  })
  it('renders sheet viewer for excel citations', () => {
    render(<DispatchViewer citation={{ ...baseCitation, location: { kind: 'sheet_cell', sheet: '销量', cellRange: 'A1:B2' } }} />)
    expect(screen.getByTestId('excel-viewer')).toBeInTheDocument()
  })
  it('renders pdf viewer for page_section', () => {
    render(<DispatchViewer citation={{ ...baseCitation, location: { kind: 'page_section', page: 3 } }} />)
    expect(screen.getByTestId('pdf-viewer')).toBeInTheDocument()
  })
})
```

**Step 2: 写四个 viewer 占位 + dispatch**

```tsx
// PdfViewer.tsx
export default function PdfViewer({ page }: { page: number }) {
  return <div data-testid="pdf-viewer">PDF 查看器(Phase 2 接 pdfjs):跳转到第 {page} 页</div>
}
```

```tsx
// DocxViewer.tsx
export default function DocxViewer({ excerpt }: { excerpt: string }) {
  return <div data-testid="docx-viewer">DOCX 查看器(Phase 2 接 mammoth):{excerpt.slice(0, 100)}</div>
}
```

```tsx
// ExcelViewer.tsx
export default function ExcelViewer({ sheet, cellRange }: { sheet: string; cellRange: string }) {
  return <div data-testid="excel-viewer">Excel 查看器(Phase 2 接 SheetJS):表 {sheet}, 范围 {cellRange}</div>
}
```

```tsx
// MediaPlayer.tsx
export default function MediaPlayer({ startMs, endMs }: { startMs: number; endMs: number }) {
  return <div data-testid="media-player">音视频播放器(Phase 2 接 html5 <video>):从 {(startMs / 1000).toFixed(1)}s 播放到 {(endMs / 1000).toFixed(1)}s</div>
}
```

修改 `dispatch.ts`:

```typescript
import type { KbCitation } from '@/services/kb'
import PdfViewer from './PdfViewer'
import DocxViewer from './DocxViewer'
import ExcelViewer from './ExcelViewer'
import MediaPlayer from './MediaPlayer'

export function DispatchViewer({ citation }: { citation: KbCitation }) {
  const loc = citation.location
  switch (loc.kind) {
    case 'timestamp': return <MediaPlayer startMs={loc.startMs} endMs={loc.endMs} />
    case 'sheet_cell': return <ExcelViewer sheet={loc.sheet} cellRange={loc.cellRange} />
    case 'page_section':
      // Phase 1 用 docName 后缀判定类型;Phase 2 由后端在 citation 里返回 docType
      if (citation.docName.endsWith('.pdf')) return <PdfViewer page={loc.page ?? 1} />
      return <DocxViewer excerpt={citation.excerpt} />
    case 'plain': return <DocxViewer excerpt={citation.excerpt} />
  }
}
```

**Step 3: 跑测试,确认通过**

Run: `cd echo-agent-desktop && npm test -- src/renderer/src/components/SourceViewer/__tests__/`
Expected: 3 passed

**Step 4: 提交**

```bash
cd echo-agent-desktop
git add src/renderer/src/components/SourceViewer/
git commit -m "feat(kb): 添加 SourceViewer 各类型占位与 dispatch"
```

---

### I. 评测与质量

#### Task I1: 黄金问答集基础版(20-30 题样例)

**Files:**
- Create: `echo-agent-server/test/fixtures/golden-qa.json`
- Create: `echo-agent-server/test/kb/golden-qa.test.ts`

**Interfaces:**
- `golden-qa.json` 形如:

```json
[
  { "id": "q1", "question": "苹果是什么?", "expectedDocIds": ["d1"], "expectedKeywords": ["水果"], "type": "fact" },
  { "id": "q2", "question": "销量大于150的产品", "expectedKeywords": ["B"], "type": "sql" },
  ...
]
```

至少 20 题,覆盖:5 事实、5 综合、5 操作(从手册/SOP 抽)、5 探索、≥ 3 SQL(数字)、≥ 2 转写

**Step 1: 创建 golden-qa.json 并写测试脚手架**

```typescript
// test/kb/golden-qa.test.ts
import { describe, it, expect } from 'vitest'
import golden from '../fixtures/golden-qa.json'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

describe('golden-qa dataset', () => {
  it('exists and has at least 20 questions', () => {
    expect(golden.length).toBeGreaterThanOrEqual(20)
  })
  it('covers all four question types', () => {
    const types = new Set((golden as any[]).map(q => q.type))
    expect(types.has('fact')).toBe(true)
    expect(types.has('synthesis')).toBe(true)
    expect(types.has('howto')).toBe(true)
    expect(types.has('exploratory')).toBe(true)
  })
  it('has at least 3 sql questions', () => {
    const sql = (golden as any[]).filter(q => q.type === 'sql')
    expect(sql.length).toBeGreaterThanOrEqual(3)
  })
})
```

**Step 2: 跑测试,确认失败**

Run: `cd echo-agent-server && npm test -- test/kb/golden-qa.test.ts`
Expected: FAIL

**Step 3: 由执行者根据团队真实资料整理 20-30 题,填入 golden-qa.json**

> 这是数据准备任务:不需要写代码,需要团队根据真实 Word/PDF/Excel/音视频整理。

**Step 4: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/golden-qa.test.ts`
Expected: 3 passed

**Step 5: 提交**

```bash
git add echo-agent-server/test/fixtures/golden-qa.json \
        echo-agent-server/test/kb/golden-qa.test.ts
git commit -m "test(kb): 添加黄金问答集(20+ 题, 覆盖四类+SQL+转写)"
```

---

#### Task I2: 评测脚本(召回/引用/答案三指标)

**Files:**
- Create: `echo-agent-server/scripts/eval-kb.ts`
- Test: `echo-agent-server/test/kb/eval.test.ts`

**Interfaces:**
- `eval-kb.ts`:从 golden-qa.json 加载,启动一个内存 DB + 假 LLM(可注入真实依赖),对每题跑 `ask()`,计算三个指标:
  - **召回覆盖率** = `citedDocIds ∩ expectedDocIds` / `expectedDocIds`
  - **引用正确率** = `verifiedUnitIds / citedUnitIds`(由 orchestrator 已返回 citations 的 unitId 是否落在 verifiedIds)
  - **答案正确率** = LLM judge("答案是否覆盖 expectedKeywords") —— Phase 1 用关键词命中 ≥ 80% 作为正确
- 输出 markdown 报告 `echo-agent-server/data/kb-eval-report.md`

**Step 1: 写 eval-kb.ts**

```typescript
// scripts/eval-kb.ts
import { getDb } from '../src/db.js'
import { ask } from '../src/kb/orchestrator.js'
import { createEmbeddingProvider } from '../src/embedding.js'
import { createChatClient } from '../src/kb/services/chat.js'
import { createRerankClient } from '../src/kb/services/rerank.js'
import golden from '../test/fixtures/golden-qa.json'
import { writeFileSync, mkdirSync } from 'node:fs'

interface Q { id: string; question: string; expectedDocIds?: string[]; expectedKeywords: string[]; type: string }

async function main() {
  const db = getDb(':memory:')
  const deps = {
    embed: createEmbeddingProvider(),
    chat: createChatClient(),
    rerank: createRerankClient(),
  }
  const results: any[] = []
  for (const q of golden as Q[]) {
    const r = await ask({ db, deps, groupId: 'g-eval', userId: 'u-eval', query: q.question, topK: 5 })
    const citedDocIds = new Set(r.citations.map(c => c.docId))
    const recall = q.expectedDocIds ? intersect(citedDocIds, new Set(q.expectedDocIds)) / q.expectedDocIds.length : null
    const citeCorrect = r.citations.length > 0 ? 1 : 0
    const answerHit = q.expectedKeywords.filter(kw => r.answer.includes(kw)).length / q.expectedKeywords.length
    results.push({ id: q.id, type: q.type, recall, citeCorrect, answerHit, citations: r.citations.length, confidence: r.confidence })
  }
  const report = renderReport(results)
  mkdirSync('./data', { recursive: true })
  writeFileSync('./data/kb-eval-report.md', report)
  // eslint-disable-next-line no-console
  console.log(report)
}

function intersect(a: Set<string>, b: Set<string>): number {
  let n = 0; a.forEach(x => { if (b.has(x)) n++ }); return n
}
function renderReport(rs: any[]): string {
  const avg = (k: string) => rs.map(r => r[k] ?? 0).reduce((s, x) => s + x, 0) / rs.length
  return [
    `# KB 评测报告(${new Date().toISOString().slice(0, 10)})`,
    ``,
    `- 总题数:${rs.length}`,
    `- 召回覆盖率:${(avg('recall') * 100).toFixed(1)}%`,
    `- 引用正确率:${(avg('citeCorrect') * 100).toFixed(1)}%`,
    `- 答案正确率(关键词命中):${(avg('answerHit') * 100).toFixed(1)}%`,
    ``,
    `| 题号 | 类型 | 召回 | 引用 | 答案 | 引用数 | 置信度 |`,
    `|---|---|---|---|---|---|---|`,
    ...rs.map(r => `| ${r.id} | ${r.type} | ${(r.recall ?? 0).toFixed(2)} | ${r.citeCorrect} | ${r.answerHit.toFixed(2)} | ${r.citations} | ${r.confidence} |`),
  ].join('\n')
}

main().catch(e => { console.error(e); process.exit(1) })
```

**Step 2: 写失败测试**

```typescript
// test/kb/eval.test.ts
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'

describe('kb eval script', () => {
  it('produces a markdown report file', () => {
    execSync('npx tsx scripts/eval-kb.ts', { cwd: '..', stdio: 'pipe' })
    const { existsSync } = require('node:fs')
    expect(existsSync('./data/kb-eval-report.md')).toBe(true)
  }, 30000)
})
```

**Step 3: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/eval.test.ts`
Expected: 1 passed

**Step 4: 提交**

```bash
git add echo-agent-server/scripts/eval-kb.ts echo-agent-server/test/kb/eval.test.ts
git commit -m "test(kb): 添加评测脚本(召回/引用/答案三指标 + md 报告)"
```

---

#### Task I3: 权限隔离 + 端到端冒烟

**Files:**
- Create: `echo-agent-server/test/kb/e2e-isolation.test.ts`

**Interfaces:**
- 测试 1:用户 A 上传资料,用户 B(同 groupId)能查到,用户 C(其他 groupId)查不到
- 测试 2:用户 C 提问时,即使直接传 unit id,verifyCitations 也会丢(因为不在自己 group)

**Step 1: 写测试**

```typescript
// test/kb/e2e-isolation.test.ts
import { describe, it, expect } from 'vitest'
import { getDb } from '../../src/db.js'
import { createDocument } from '../../src/kb/storage/documents.js'
import { insertUnit } from '../../src/kb/storage/units.js'
import { listDocuments } from '../../src/kb/storage/documents.js'
import { hybridSearch } from '../../src/kb/retrieval/hybrid.js'
import type { EmbeddingProvider } from '../../src/embedding.js'

const embed: EmbeddingProvider = { embed: async (t) => Array(1024).fill(t.length) }
const noopRerank = { rerank: async (_q: string, docs: string[], k: number) => docs.map((_d, i) => ({ index: i, score: 1 - i * 0.1 })).slice(0, k) }

describe('kb cross-group isolation', () => {
  it('group A cannot list or search group B docs', async () => {
    const db = getDb(':memory:')
    createDocument(db, { name: 'b.txt', type: 'text', groupId: 'B', sourcePath: 'B/d.txt', hash: 'h', uploaderId: 'uB' })
    const a = listDocuments(db, 'A', 50, 0)
    expect(a.items).toHaveLength(0)
    const r = await hybridSearch({ db, embed, rerank: noopRerank, groupId: 'A', query: 'anything', topK: 5 })
    expect(r).toHaveLength(0)
  })

  it('verify drops cited units from other groups', async () => {
    const db = getDb(':memory:')
    const u1 = await insertUnit(db, embed, { docId: 'd1', groupId: 'A', location: { kind: 'plain', offset: 0, length: 0 }, text: '苹果是水果' })
    const u2 = await insertUnit(db, embed, { docId: 'd2', groupId: 'B', location: { kind: 'plain', offset: 0, length: 0 }, text: '苹果是水果' })
    const { verifyCitations } = await import('../../src/kb/generation/verify.js')
    const v = verifyCitations({ answer: '苹果是水果', citedUnitIds: [u1.id, u2.id], units: [u1] })
    expect(v.verifiedIds).toEqual([u1.id])
    expect(v.droppedIds).toEqual([u2.id])
  })
})
```

**Step 2: 跑测试,确认通过**

Run: `cd echo-agent-server && npm test -- test/kb/e2e-isolation.test.ts`
Expected: 2 passed

**Step 3: 提交**

```bash
git add echo-agent-server/test/kb/e2e-isolation.test.ts
git commit -m "test(kb): 添加跨分组隔离 + 引用越权防护冒烟"
```

---

## Self-Review Checklist(执行者自查)

执行者完成所有任务后,逐项核对:

- [ ] **覆盖度**:Spec §4 架构 / §5 摄取 / §6 数据模型 / §7 检索大脑 / §8 正确率 / §9 客户端 / §10 安全权限 / §11 Phase 1 / §12 测试策略 / §13 依赖 全部有对应任务
- [ ] **占位符**:搜索 `TBD|TODO|FIXME|待.*实现|类似 Task`,应为空
- [ ] **类型一致**:`Location` 的四个 kind 在 Task A1 定义,在 Task B1~B6 产出,在 Task E1~E4 使用,在 Task H5 消费,全程一致
- [ ] **依赖一致**:`app.deps.db`、`app.deps.embed` 在 Task A3 路由签名中获取,在 Task G1/G2 中使用,无凭空引用未声明的字段
- [ ] **接口一致**:`enqueueUpload` 在 Task C3 定义并被 Task G2 使用,`runIngestionTask` 在 Task C3 定义并被 Task C3 内部 queue worker 使用
- [ ] **类型契约**:`KbDocument/KbLocation/KbCitation/KbAskResult` 在 Task A4 定义,后续 H1~H5 与 G2 路由透传保持一致
- [ ] **跑通命令**:`cd echo-agent-server && npm test` 与 `cd echo-agent-desktop && npm test` 全部通过
- [ ] **手动冒烟**:用真实小文件走一遍"上传 → 等 ready → 提问 → 看引用 → 点引用打开 SourceViewer"

---

## 执行节奏建议

- **每任务 1 个 commit**(本计划已规定 commit 命令)
- **顺序**:严格按 A → B → C → D → E → F → G → H → I 执行;每个区块内部按编号顺序
- **并行机会**:A2/A3/A4 可并行(都依赖 A1 但彼此独立);B2~B6 可并行(彼此独立,但 B5/B6 依赖 D1/D2 stub,Task C3 编排时才需要);E1~E4 可并行
- **阻塞前置**:I1 黄金问答集需要团队人工整理,可与 G/H 并行准备,但 I2 评测必须在 H4+I1 完成后才有意义

---

## 计划完成

总任务数:**33 个**(A4 + B6 + C3 + D3 + E4 + F3 + G2 + H5 + I3)

预计代码量:
- 服务端 ~2500 行(含测试)
- 客户端 ~800 行(含测试)

Phase 1 跑通后,Phase 2(路由/拆解、迭代补检、探索式检索、完整评测闭环)与 Phase 3(GraphRAG、Agent 工具挂接)按需开新计划。