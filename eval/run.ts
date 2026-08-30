/**
 * Eval runner —— 黄金评估集门禁。
 *
 * 流程:
 *   1. 加载 `eval/dataset.jsonl`;
 *   2. 通过 HTTP 调 `/api/v1/auth/login` 取 token(按 `as_user` 模拟身份);
 *   3. 调 `/api/v1/retrieve`;
 *   4. 计算 Recall/Precision/Faithfulness/Relevance/权限泄露/无答案正确率/p95;
 *   5. 输出 `eval/reports/<date>.json` 与控制台表格;
 *   6. 任一硬阈值未达标则 exit 1。
 *
 * 设计原则:
 *   - 仅依赖运行中的 HTTP 服务,不复用内部类型 —— 与生产路径完全一致;
 *   - 不写入数据库;读 fixture 即可;
 *   - judge 模型可选 —— 缺配置时回退到基于引用的近似。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildJudge } from './judge.js'

const HERE = dirname(fileURLToPath(import.meta.url))

interface DatasetRow {
  id: string
  kind: 'fact' | 'multi_hop' | 'exact_term' | 'no_answer' | 'permission'
  question: string
  expected_doc_ids: string[]
  expected_answer_points: string[]
  as_user: string
  must_not_leak?: string[]
}

interface RetrievedChunk {
  chunkId: string
  docId: string
  docTitle: string
  text: string
  score: number
  scopeKind: string
  citation: { page: number | null; heading: string; startMs: number | null }
  owner: { id: string; displayName: string } | null
  stale: boolean
}

interface RetrieveResponse {
  chunks: RetrievedChunk[]
  memories: { id: string; kind: string; content: string }[]
  suggestAsk?: { userId: string; displayName: string; reason: string }[]
  diagnostics: {
    bm25Hits: number
    vecHits: number
    fusedCandidates: number
    rerankMs: number
    rerankSkipped: boolean
    totalMs: number
  }
}

interface CaseResult {
  id: string
  kind: DatasetRow['kind']
  asUser: string
  latencyMs: number
  recall: 0 | 1
  precision: number
  faithfulness: 0 | 1 | null
  relevance: 0 | 1 | null
  noAnswerCorrect: 0 | 1 | null
  leak: 0 | 1
  hits?: Array<{ docId: string; score: number; text: string }>
  notes?: string
}

interface RunReport {
  startedAt: string
  finishedAt: string
  total: number
  metrics: {
    recall: number
    precision: number
    faithfulness: number | null
    relevance: number | null
    noAnswerCorrect: number | null
    permissionLeak: number
    p95LatencyMs: number
  }
  thresholds: {
    recall: number
    precision: number
    faithfulness: number | null
    relevance: number | null
    noAnswerCorrect: number | null
    p95LatencyMs: number
    permissionLeakMax: number
  }
  pass: boolean
  results: CaseResult[]
}

const BASE_URL = process.env.ECHO_EVAL_BASE_URL ?? 'http://127.0.0.1:8787'
const USERS_ENV = process.env.ECHO_EVAL_USERS ?? ''
// ECHO_EVAL_USERS 形如: "u_member_1:alice-pw,u_member_fin:carol-pw,admin:admin-pw"
// 缺省回退:用 admin 跑全部用例 —— 仅用于自检;正式门禁必须按权限用例设置。

const USER_MAP = parseUserMap(USERS_ENV)

function parseUserMap(s: string): Map<string, string> {
  const m = new Map<string, string>()
  if (!s) return m
  for (const pair of s.split(',')) {
    const [u, p] = pair.split(':')
    if (u && p) m.set(u, p)
  }
  return m
}

async function loginAs(username: string): Promise<string> {
  // 优先用 ECHO_EVAL_USERS 显式提供的凭据;
  // 其次 fixture 用户的默认密码是 "<sanitized>-pw";
  // 最后 admin 回退到 ECHO_ADMIN_PASSWORD。
  let password = USER_MAP.get(username) ?? ''
  if (!password && username !== 'admin') {
    password = `${username.replace(/[^a-z0-9]/gi, '')}-pw`
  }
  if (!password) {
    password = process.env.ECHO_ADMIN_PASSWORD ?? 'admin-pw-12345'
  }
  // 不同 deviceId 避开 IP+username 限流的 device 维度。
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceId: `eval-${username}-${Math.random().toString(36).slice(2, 8)}` })
  })
  if (!res.ok) {
    throw new Error(`登录失败 ${username}: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { data?: { accessToken?: string } }
  if (!body.data?.accessToken) throw new Error(`登录响应缺少 accessToken (${username})`)
  return body.data.accessToken
}

/**
 * 确保 fixture 用户存在。
 *
 * eval 套件需要多个不同身份跑测试;直接登录受限于 IP + username 5/min 限流,
 * 改用 admin 一次性创建/重置所有 fixture 用户,再走单点登录。
 */
async function ensureFixtureUser(adminToken: string, username: string, password: string): Promise<void> {
  const listRes = await fetch(`${BASE_URL}/api/v1/admin/users`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  if (!listRes.ok) {
    throw new Error(`list users ${listRes.status}`)
  }
  const list = ((await listRes.json()).data ?? []) as { id: string; username: string }[]
  const existing = list.find((x) => x.username === username)
  if (existing) {
    const res = await fetch(`${BASE_URL}/api/v1/admin/users/${existing.id}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ password })
    })
    if (!res.ok) throw new Error(`reset pw ${res.status}: ${await res.text()}`)
    return
  }
  const res = await fetch(`${BASE_URL}/api/v1/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ username, password, role: 'member' })
  })
  if (!res.ok) throw new Error(`create user ${res.status}: ${await res.text()}`)
}

async function bootstrapFixtureUsers(adminToken: string, rows: DatasetRow[]): Promise<void> {
  // 至少确保 dataset 中出现的所有 as_user 都存在;默认密码统一为 username + "-pw"。
  const usernames = new Set<string>(rows.map((r) => r.as_user))
  for (const u of usernames) {
    if (u === 'admin') continue
    const password = USER_MAP.get(u) ?? `${u.replace(/[^a-z0-9]/gi, '')}-pw`
    try {
      await ensureFixtureUser(adminToken, u, password)
      console.log(`[eval] fixture 已就绪: ${u}`)
    } catch (e) {
      console.warn(`[eval] 创建 fixture 用户失败 (${u}): ${(e as Error).message}`)
    }
  }
}

async function callRetrieve(
  token: string,
  query: string,
  multiHop: boolean
): Promise<{ res: RetrieveResponse; ms: number }> {
  const t0 = Date.now()
  const res = await fetch(`${BASE_URL}/api/v1/retrieve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, limit: 8, multi_hop: multiHop })
  })
  const ms = Date.now() - t0
  if (!res.ok) throw new Error(`retrieve ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { data?: RetrieveResponse }
  if (!body.data) throw new Error('retrieve 响应缺少 data')
  return { res: body.data, ms }
}

/** 基于引用的 faithfulness 近似:所有 answer points 都能在 chunk/memory text 中找到匹配。 */
function fallbackFaithfulness(row: DatasetRow, res: RetrieveResponse): 0 | 1 {
  if (row.expected_answer_points.length === 0) return 1
  const normalize = (value: string): string => value
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '')
  const haystack = normalize(
    res.chunks.map((c) => c.text).join(' ') + ' ' + res.memories.map((m) => m.content).join(' ')
  )
  for (const p of row.expected_answer_points) {
    if (!haystack.includes(normalize(p))) return 0
  }
  return 1
}

/** 基于命中的 relevance 近似:对 fact/multi_hop/exact_term,期望文档出现在结果中即为 1。 */
function fallbackRelevance(row: DatasetRow, res: RetrieveResponse): 0 | 1 {
  if (row.kind === 'no_answer') return res.chunks.length === 0 ? 1 : 0
  if (row.expected_doc_ids.length === 0) return res.chunks.length === 0 ? 1 : 0
  const hits = new Set(res.chunks.map((c) => c.docId))
  return row.expected_doc_ids.some((d) => hits.has(d)) ? 1 : 0
}

function detectLeak(row: DatasetRow, res: RetrieveResponse): 0 | 1 {
  if (!row.must_not_leak || row.must_not_leak.length === 0) return 0
  const docIds = new Set(res.chunks.map((c) => c.docId))
  return row.must_not_leak.some((d) => docIds.has(d)) ? 1 : 0
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx]
}

/** 仅对有 expected_doc_ids 的题型计算 Recall/Precision;no_answer 走另一指标。 */
function recallPrecisionDenominator(row: DatasetRow): boolean {
  return row.kind !== 'no_answer'
}

async function run(): Promise<number> {
  const startedAt = new Date().toISOString()
  const datasetPath = join(HERE, 'dataset.jsonl')
  const raw = readFileSync(datasetPath, 'utf8')
  const rows: DatasetRow[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))

  console.log(`[eval] 共 ${rows.length} 条评估;base=${BASE_URL}`)

  const tokenCache = new Map<string, string>()
  const results: CaseResult[] = []
  const latencies: number[] = []

  // judge 模型可选:无配置时所有 faithfulness/relevance 用 fallback。
  const judge = buildJudge()

  // 用 admin 一次性创建/重置所有 fixture 用户,避开 IP+username 限流。
  // 失败也继续跑,登录失败会在每条用例上显式记录。
  try {
    const adminToken = await loginAs('admin')
    await bootstrapFixtureUsers(adminToken, rows)
    tokenCache.set('admin', adminToken)
  } catch (e) {
    console.warn(`[eval] fixture 用户预创建失败 (将逐题尝试): ${(e as Error).message}`)
  }

  for (const row of rows) {
    let token: string | undefined = tokenCache.get(row.as_user)
    if (!token) {
      try {
        token = await loginAs(row.as_user)
        tokenCache.set(row.as_user, token)
      } catch (e) {
        console.warn(`[eval] ${row.id} 登录失败 (${row.as_user}): ${(e as Error).message}`)
        results.push({
          id: row.id,
          kind: row.kind,
          asUser: row.as_user,
          latencyMs: 0,
          recall: 0,
          precision: 0,
          faithfulness: null,
          relevance: null,
          noAnswerCorrect: null,
          leak: 0,
          notes: 'login_failed'
        })
        continue
      }
    }

    try {
      const { res, ms } = await callRetrieve(token, row.question, row.kind === 'multi_hop')
      latencies.push(ms)

      const recall =
        !recallPrecisionDenominator(row)
          ? (res.chunks.length === 0 ? 1 : 0)
          : row.expected_doc_ids.length === 0
            ? (res.chunks.length === 0 ? 1 : 0)
            : res.chunks.some((c) => row.expected_doc_ids.includes(c.docId))
              ? 1
              : 0
      const precision =
        !recallPrecisionDenominator(row)
          ? (res.chunks.length === 0 ? 1 : 0)
          : row.expected_doc_ids.length === 0
            ? (res.chunks.length === 0 ? 1 : 0)
            : (() => {
                if (res.chunks.length === 0) return 0
                const relevant = res.chunks.filter((c) =>
                  row.expected_doc_ids.includes(c.docId)
                ).length
                return relevant / res.chunks.length
              })()

      const noAnswerCorrect =
        row.kind === 'no_answer'
          ? res.chunks.length === 0 && res.memories.length === 0
            ? 1
            : 0
          : null

      const leak = detectLeak(row, res)
      let faithfulness: 0 | 1 | null = fallbackFaithfulness(row, res)
      let relevance: 0 | 1 | null = fallbackRelevance(row, res)
      if (judge) {
        try {
          const ev = res.chunks.map((c) => c.text).join('\n---\n')
          const f = await judge.faithful(row.question, row.expected_answer_points, ev)
          if (f) faithfulness = f.score
          const r = await judge.relevant(
            row.question,
            row.expected_doc_ids,
            res.chunks.map((c) => c.docTitle)
          )
          if (r) relevance = r.score
        } catch {
          // judge 失败 → 保留 fallback 结果。
        }
      }

      results.push({
        id: row.id,
        kind: row.kind,
        asUser: row.as_user,
        latencyMs: ms,
        recall: recall as 0 | 1,
        precision,
        faithfulness,
        relevance,
        noAnswerCorrect,
        leak,
        hits: res.chunks.map((chunk) => ({
          docId: chunk.docId,
          score: chunk.score,
          text: chunk.text.slice(0, 300)
        }))
      })

      process.stdout.write(
        `\r[eval] ${results.length}/${rows.length} ${row.id} (${ms}ms)` +
          ' '.repeat(8)
      )
    } catch (e) {
      console.warn(`\n[eval] ${row.id} retrieve 失败: ${(e as Error).message}`)
      results.push({
        id: row.id,
        kind: row.kind,
        asUser: row.as_user,
        latencyMs: 0,
        recall: 0,
        precision: 0,
        faithfulness: null,
        relevance: null,
        noAnswerCorrect: null,
        leak: 0,
        notes: 'retrieve_failed'
      })
    }
  }
  process.stdout.write('\n')

  // 聚合
  const safe = (n: number, d: number): number => (d === 0 ? 0 : n / d)
  const recallDenom = results.filter((r) => recallPrecisionDenominator(rows.find((x) => x.id === r.id)!)).length
  const recallAvg = safe(
    results
      .filter((result) => recallPrecisionDenominator(rows.find((row) => row.id === result.id)!))
      .reduce((sum, result) => sum + result.recall, 0),
    recallDenom
  )
  const precisionAvg = safe(
    results.reduce((s, r) => s + r.precision, 0),
    recallDenom
  )
  const faithfulnessAvg = ((): number | null => {
    const xs = results.map((r) => r.faithfulness).filter((x): x is 0 | 1 => x !== null)
    return xs.length === 0 ? null : safe(xs.reduce((s, x) => s + x, 0), xs.length)
  })()
  const relevanceAvg = ((): number | null => {
    const xs = results.map((r) => r.relevance).filter((x): x is 0 | 1 => x !== null)
    return xs.length === 0 ? null : safe(xs.reduce((s, x) => s + x, 0), xs.length)
  })()
  const noAnswerCorrectAvg = ((): number | null => {
    const xs = results.map((r) => r.noAnswerCorrect).filter((x): x is 0 | 1 => x !== null)
    return xs.length === 0 ? null : safe(xs.reduce((s, x) => s + x, 0), xs.length)
  })()
  const leakTotal = results.reduce((s, r) => s + r.leak, 0)
  const sorted = [...latencies].sort((a, b) => a - b)
  const p95LatencyMs = percentile(sorted, 0.95)

  const thresholds = {
    recall: 0.85,
    precision: 0.7,
    faithfulness: 0.8,
    relevance: 0.85,
    noAnswerCorrect: 0.9,
    p95LatencyMs: 800,
    permissionLeakMax: 0
  }

  const checks: Array<[string, boolean, string]> = [
    ['Recall', recallAvg >= thresholds.recall, `${recallAvg.toFixed(3)} ≥ ${thresholds.recall}`],
    ['Precision', precisionAvg >= thresholds.precision, `${precisionAvg.toFixed(3)} ≥ ${thresholds.precision}`],
    [
      'Faithfulness',
      faithfulnessAvg === null || faithfulnessAvg >= thresholds.faithfulness,
      `${(faithfulnessAvg ?? 0).toFixed(3)} ≥ ${thresholds.faithfulness}`
    ],
    [
      'Relevance',
      relevanceAvg === null || relevanceAvg >= thresholds.relevance,
      `${(relevanceAvg ?? 0).toFixed(3)} ≥ ${thresholds.relevance}`
    ],
    [
      'NoAnswer',
      noAnswerCorrectAvg === null || noAnswerCorrectAvg >= thresholds.noAnswerCorrect,
      `${(noAnswerCorrectAvg ?? 0).toFixed(3)} ≥ ${thresholds.noAnswerCorrect}`
    ],
    ['p95', p95LatencyMs <= thresholds.p95LatencyMs, `${p95LatencyMs}ms ≤ ${thresholds.p95LatencyMs}ms`],
    [
      'PermissionLeak',
      leakTotal <= thresholds.permissionLeakMax,
      `${leakTotal} 次泄露 ≤ ${thresholds.permissionLeakMax}`
    ]
  ]

  const pass = checks.every(([, ok]) => ok)

  console.log('\n[eval] 结果')
  console.log('─'.repeat(60))
  for (const [name, ok, msg] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(15)} ${msg}`)
  }
  console.log('─'.repeat(60))
  console.log(`  Recall           ${recallAvg.toFixed(3)}`)
  console.log(`  Precision        ${precisionAvg.toFixed(3)}`)
  if (faithfulnessAvg !== null) console.log(`  Faithfulness     ${faithfulnessAvg.toFixed(3)}`)
  if (relevanceAvg !== null) console.log(`  Relevance        ${relevanceAvg.toFixed(3)}`)
  if (noAnswerCorrectAvg !== null) console.log(`  NoAnswerCorrect  ${noAnswerCorrectAvg.toFixed(3)}`)
  console.log(`  p95 latency      ${p95LatencyMs}ms`)
  console.log(`  Permission leak  ${leakTotal}`)
  console.log(`  PASS             ${pass}`)

  const report: RunReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    total: rows.length,
    metrics: {
      recall: recallAvg,
      precision: precisionAvg,
      faithfulness: faithfulnessAvg,
      relevance: relevanceAvg,
      noAnswerCorrect: noAnswerCorrectAvg,
      permissionLeak: leakTotal,
      p95LatencyMs
    },
    thresholds,
    pass,
    results
  }

  const reportsDir = join(HERE, 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const date = startedAt.replace(/[:.]/g, '-').slice(0, 19)
  writeFileSync(join(reportsDir, `${date}.json`), JSON.stringify(report, null, 2))

  judge?.close()
  return pass ? 0 : 1
}

run()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[eval] 异常:', e)
    process.exit(2)
  })

export {}
