import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDb, type DB } from '../../src/db/index.js'
import { testConfig } from '../../src/config.js'
import { createEmbedder } from '../../src/models/embedder.js'
import { createReranker } from '../../src/models/reranker.js'
import { Retriever } from '../../src/kb/retrieve/index.js'
import { chunkBlocks } from '../../src/kb/ingest/chunk.js'
import { indexChunks } from '../../src/kb/ingest/indexer.js'
import { hashPassword } from '../../src/crypto.js'

// 端到端:建组织架构 → 摄取文档 → 检索。重点验证权限边界,
// 那是整套设计的安全前提,不能只靠代码审查。

const cfg = testConfig()
const embedder = createEmbedder(cfg)
const reranker = createReranker(cfg)

async function seed(db: DB): Promise<void> {
  const now = Date.now()
  db.prepare("INSERT INTO groups VALUES ('g_fin','财务部',NULL,'',?)").run(now)
  db.prepare("INSERT INTO groups VALUES ('g_tech','技术部',NULL,'',?)").run(now)
  db.prepare("INSERT INTO groups VALUES ('g_be','后端组','g_tech','',?)").run(now)

  db.prepare("INSERT INTO scopes VALUES ('s_org','org',NULL,'全公司')").run()
  db.prepare("INSERT INTO scopes VALUES ('s_fin','team','g_fin','财务部')").run()
  db.prepare("INSERT INTO scopes VALUES ('s_tech','team','g_tech','技术部')").run()
  db.prepare("INSERT INTO scopes VALUES ('s_be','team','g_be','后端组')").run()

  const hash = await hashPassword('pw')
  const mkUser = (
    id: string,
    name: string,
    clearance = 0,
    status = 'active'
  ): void => {
    db.prepare(
      `INSERT INTO users (id,username,display_name,password_hash,role,status,clearance,created_at)
       VALUES (?,?,?,?,'member',?,?,?)`
    ).run(id, name, name, hash, status, clearance, now)
  }
  mkUser('u_fin', '财务小王')
  mkUser('u_be', '后端小李')
  mkUser('u_boss', '老板', 2)
  mkUser('u_gone', '离职者')

  db.prepare("INSERT INTO user_groups VALUES ('u_fin','g_fin')").run()
  db.prepare("INSERT INTO user_groups VALUES ('u_be','g_be')").run()
  db.prepare("INSERT INTO user_groups VALUES ('u_gone','g_fin')").run()
}

async function addDoc(
  db: DB,
  opts: {
    id?: string
    scopeId: string
    title: string
    text: string
    sensitivity?: number
    ownerId?: string
    volatility?: string
    updatedAt?: number
    page?: number
  }
): Promise<string> {
  const id = opts.id ?? randomUUID()
  const now = opts.updatedAt ?? Date.now()
  db.prepare(
    `INSERT INTO documents (id,scope_id,title,source_type,content_hash,owner_id,
                            sensitivity,volatility,status,created_at,updated_at)
     VALUES (?,?,?,'md',?,?,?,?,'ready',?,?)`
  ).run(
    id,
    opts.scopeId,
    opts.title,
    randomUUID(),
    opts.ownerId ?? null,
    opts.sensitivity ?? 0,
    opts.volatility ?? 'stable',
    now,
    now
  )
  const drafts = chunkBlocks([
    { kind: 'heading', text: opts.title, level: 1 },
    { kind: 'para', text: opts.text, page: opts.page }
  ])
  await indexChunks(db, id, drafts, embedder, 'test-v1')
  return id
}

describe('检索链路端到端', () => {
  let db: DB
  let retriever: Retriever

  beforeEach(async () => {
    db = openDb({ path: ':memory:' })
    await seed(db)
    retriever = new Retriever({ db, cfg, embedder, reranker })
  })

  it('能检索到组织层文档并带引用信息', async () => {
    await addDoc(db, {
      scopeId: 's_org',
      title: '差旅管理办法',
      text: '一线城市住宿标准 500 元每晚,其他城市 350 元每晚。',
      ownerId: 'u_fin',
      page: 7
    })

    const res = await retriever.retrieve('u_be', { query: '住宿标准' })
    expect(res.chunks.length).toBeGreaterThan(0)
    const hit = res.chunks[0]
    expect(hit.text).toContain('500')
    expect(hit.docTitle).toBe('差旅管理办法')
    expect(hit.scopeKind).toBe('org')
    expect(hit.citation.page).toBe(7)
    expect(hit.citation.openUrl).toContain('echo://doc/')
    expect(hit.owner?.displayName).toBe('财务小王')
  })

  it('团队文档对本组可见', async () => {
    await addDoc(db, {
      scopeId: 's_fin',
      title: '财务内部流程',
      text: '发票审核由财务专员初审,金额超过一万元需总监复核。'
    })
    const res = await retriever.retrieve('u_fin', { query: '发票审核' })
    expect(res.chunks.length).toBeGreaterThan(0)
  })

  // 这是整套权限设计的核心断言。失败即意味着越权泄露。
  it('团队文档对其他部门不可见', async () => {
    await addDoc(db, {
      scopeId: 's_fin',
      title: '财务内部流程',
      text: '发票审核由财务专员初审,金额超过一万元需总监复核。'
    })
    const res = await retriever.retrieve('u_be', { query: '发票审核' })
    expect(res.chunks).toHaveLength(0)
  })

  it('嵌套组成员能看到父组文档', async () => {
    await addDoc(db, {
      scopeId: 's_tech',
      title: '技术部规范',
      text: '代码提交前必须通过静态检查与单元测试。'
    })
    // u_be 属于后端组,后端组的父组是技术部
    const res = await retriever.retrieve('u_be', { query: '代码提交' })
    expect(res.chunks.length).toBeGreaterThan(0)
  })

  it('父组成员看不到子组文档', async () => {
    await addDoc(db, {
      scopeId: 's_be',
      title: '后端组约定',
      text: '数据库变更必须走迁移脚本,禁止手工改表。'
    })
    // 需要一个只属于技术部的用户
    db.prepare(
      `INSERT INTO users (id,username,display_name,password_hash,role,status,clearance,created_at)
       VALUES ('u_tech','技术总监','技术总监','h','member','active',0,?)`
    ).run(Date.now())
    db.prepare("INSERT INTO user_groups VALUES ('u_tech','g_tech')").run()

    const res = await retriever.retrieve('u_tech', { query: '数据库变更' })
    expect(res.chunks).toHaveLength(0)
  })

  it('密级高于 clearance 的文档不可见', async () => {
    await addDoc(db, {
      scopeId: 's_org',
      title: '董事会薪酬决议',
      text: '高管薪酬调整方案已于本季度董事会通过。',
      sensitivity: 2
    })
    const normal = await retriever.retrieve('u_be', { query: '薪酬决议' })
    expect(normal.chunks).toHaveLength(0)

    const boss = await retriever.retrieve('u_boss', { query: '薪酬决议' })
    expect(boss.chunks.length).toBeGreaterThan(0)
  })

  it('禁用用户失去全部可见性', async () => {
    await addDoc(db, {
      scopeId: 's_org',
      title: '员工手册',
      text: '公司实行弹性工作制,核心工作时间为上午十点到下午四点。'
    })
    const before = await retriever.retrieve('u_gone', { query: '弹性工作制' })
    expect(before.chunks.length).toBeGreaterThan(0)

    db.prepare("UPDATE users SET status='disabled' WHERE id='u_gone'").run()
    const after = await retriever.retrieve('u_gone', { query: '弹性工作制' })
    expect(after.chunks).toHaveLength(0)
  })

  it('移出分组后立即失去该组文档可见性(不等 token 过期)', async () => {
    await addDoc(db, {
      scopeId: 's_fin',
      title: '财务内部流程',
      text: '发票审核由财务专员初审,金额超过一万元需总监复核。'
    })
    const before = await retriever.retrieve('u_fin', { query: '发票审核' })
    expect(before.chunks.length).toBeGreaterThan(0)

    db.prepare("DELETE FROM user_groups WHERE user_id='u_fin'").run()
    const after = await retriever.retrieve('u_fin', { query: '发票审核' })
    expect(after.chunks).toHaveLength(0)
  })

  it('archived 文档不再被检索命中', async () => {
    const id = await addDoc(db, {
      scopeId: 's_org',
      title: '旧版报销制度',
      text: '报销单需在费用发生后三十日内提交。'
    })
    const before = await retriever.retrieve('u_be', { query: '报销单' })
    expect(before.chunks.length).toBeGreaterThan(0)

    db.prepare("UPDATE documents SET status='archived' WHERE id=?").run(id)
    const after = await retriever.retrieve('u_be', { query: '报销单' })
    expect(after.chunks).toHaveLength(0)
  })

  it('中文多字词能被召回(bigram 生效)', async () => {
    await addDoc(db, {
      scopeId: 's_org',
      title: '报销制度',
      text: '报销审批流程分为三级,部门主管、财务复核、总经理终审。'
    })
    const res = await retriever.retrieve('u_be', { query: '报销审批' })
    expect(res.chunks.length).toBeGreaterThan(0)
    expect(res.diagnostics.bm25Hits).toBeGreaterThan(0)
  })

  it('精确词(型号/缩写)靠 BM25 命中', async () => {
    await addDoc(db, {
      scopeId: 's_org',
      title: '设备台账',
      text: 'XR2000 型服务器保修期为三年,由 IT 部门统一管理。'
    })
    const res = await retriever.retrieve('u_be', { query: 'XR2000' })
    expect(res.chunks.length).toBeGreaterThan(0)
  })

  it('无结果时给出该问谁', async () => {
    await addDoc(db, {
      scopeId: 's_org',
      title: '员工手册',
      text: '公司实行弹性工作制。',
      ownerId: 'u_fin'
    })
    const res = await retriever.retrieve('u_be', {
      query: '量子计算机采购预算是多少'
    })
    expect(res.chunks).toHaveLength(0)
    expect(res.suggestAsk?.length).toBeGreaterThan(0)
    expect(res.suggestAsk?.[0].displayName).toBe('财务小王')
  })

  it('volatile 且陈旧的文档被标记 stale', async () => {
    const old = Date.now() - 200 * 24 * 3600_000
    await addDoc(db, {
      scopeId: 's_org',
      title: '临时通知',
      text: '本月食堂供餐时间调整为十一点半开始。',
      volatility: 'volatile',
      updatedAt: old
    })
    const res = await retriever.retrieve('u_be', { query: '食堂供餐时间' })
    expect(res.chunks[0]?.stale).toBe(true)
  })

  it('组织记忆能被检索到', async () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO org_memories (id,scope_id,kind,content,confidence,status,created_at,updated_at)
       VALUES ('m1','s_org','convention','报销单需直属上级先签字再交财务。',0.9,'active',?,?)`
    ).run(now, now)

    const res = await retriever.retrieve('u_be', { query: '报销单签字' })
    expect(res.memories.length).toBeGreaterThan(0)
    expect(res.memories[0].content).toContain('直属上级')
  })

  it('组织记忆同样受 scope 限制', async () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO org_memories (id,scope_id,kind,content,confidence,status,created_at,updated_at)
       VALUES ('m2','s_fin','convention','财务系统密码每季度轮换一次。',0.9,'active',?,?)`
    ).run(now, now)

    const outsider = await retriever.retrieve('u_be', { query: '财务系统密码' })
    expect(outsider.memories).toHaveLength(0)

    const insider = await retriever.retrieve('u_fin', { query: '财务系统密码' })
    expect(insider.memories.length).toBeGreaterThan(0)
  })

  it('diagnostics 反映两路召回与精排耗时', async () => {
    await addDoc(db, {
      scopeId: 's_org',
      title: '报销制度',
      text: '报销审批流程分为三级审批。'
    })
    const res = await retriever.retrieve('u_be', { query: '报销审批' })
    expect(res.diagnostics.totalMs).toBeGreaterThanOrEqual(0)
    expect(res.diagnostics.fusedCandidates).toBeGreaterThan(0)
    expect(res.diagnostics.rerankSkipped).toBe(false)
  })

  it('同一文档的 chunk 不会挤满结果', async () => {
    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO documents (id,scope_id,title,source_type,content_hash,status,created_at,updated_at)
       VALUES (?,'s_org','长文档','md',?,'ready',?,?)`
    ).run(id, randomUUID(), now, now)

    const blocks = Array.from({ length: 20 }, (_, i) => ({
      kind: 'para' as const,
      text: `第${i}节 报销标准说明,涉及差旅住宿与交通费用的具体额度规定。`
    }))
    await indexChunks(db, id, chunkBlocks(blocks), embedder, 'test-v1')

    const res = await retriever.retrieve('u_be', { query: '报销标准', limit: 8 })
    const fromThisDoc = res.chunks.filter((c) => c.docId === id)
    expect(fromThisDoc.length).toBeLessThanOrEqual(3)
  })
})

// "诚实说不知道"是可信度的底线,也是方案里 >=0.90 无答案正确率的前提。
// 向量检索永远返回 k 个最近邻,没有相关度下限就永远有"材料",模型于是
// 从无关内容里编答案。这组测试专门守住这条线。
describe('无答案场景', () => {
  let db: DB
  let retriever: Retriever

  beforeEach(async () => {
    db = openDb({ path: ':memory:' })
    await seed(db)
    retriever = new Retriever({ db, cfg, embedder, reranker })
    // 库里有内容,但与下面的提问毫无关系
    await addDoc(db, {
      scopeId: 's_org',
      title: '员工手册',
      text: '公司实行弹性工作制,核心工作时间为上午十点到下午四点。',
      ownerId: 'u_fin'
    })
    await addDoc(db, {
      scopeId: 's_org',
      title: '差旅管理办法',
      text: '一线城市住宿标准 500 元每晚。'
    })
  })

  it('完全无关的提问不返回任何材料', async () => {
    const res = await retriever.retrieve('u_be', {
      query: '量子计算机采购预算是多少'
    })
    expect(res.chunks).toHaveLength(0)
  })

  it('无关提问也不返回记忆', async () => {
    const res = await retriever.retrieve('u_be', { query: '南极科考站选址' })
    expect(res.memories).toHaveLength(0)
  })

  it('空库任何提问都无结果', async () => {
    const fresh = openDb({ path: ':memory:' })
    await seed(fresh)
    const r = new Retriever({ db: fresh, cfg, embedder, reranker })
    const res = await r.retrieve('u_be', { query: '住宿标准' })
    expect(res.chunks).toHaveLength(0)
  })

  it('相关提问仍能正常命中(阈值没有过度收紧)', async () => {
    const res = await retriever.retrieve('u_be', { query: '弹性工作制' })
    expect(res.chunks.length).toBeGreaterThan(0)
  })

  it('空查询串不报错且无结果', async () => {
    const res = await retriever.retrieve('u_be', { query: '   ' })
    expect(res.chunks).toHaveLength(0)
  })

  it('FTS 特殊字符不会导致 SQL 报错', async () => {
    for (const q of ['"引号"', 'a*b', '(括号)', 'x^2', '--破折号', 'NEAR(a b)']) {
      const res = await retriever.retrieve('u_be', { query: q })
      expect(Array.isArray(res.chunks)).toBe(true)
    }
  })
})
