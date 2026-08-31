import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConfig } from '../../src/config.js'
import { openDb } from '../../src/db/index.js'
import {
  assessEvidence,
  fallbackPlan,
  planQuestion,
  validateClaimsDeterministically,
  verifyClaims,
  type AgentEvidence
} from '../../src/kb/agentic.js'
import { extractJson } from '../../src/models/structured-chat.js'

const evidence: AgentEvidence[] = [{
  citationId: 'cit-1',
  title: '审批制度',
  heading: '审批条件',
  page: 1,
  text: '报销金额不得超过五百元，并且至少需要两级审批。',
  score: 0.95,
  stale: false
}]

afterEach(() => vi.unstubAllGlobals())

describe('Agentic RAG 规划与结构化输出', () => {
  it('规则降级能识别比较/多条件问题并保留原问题', () => {
    const plan = fallbackPlan('比较甲乙方案的区别以及各自审批条件', 'auto')
    expect(plan.mode).toBe('deep')
    expect(plan.intent).toBe('comparison')
    expect(plan.subQueries[0]).toBe('比较甲乙方案的区别以及各自审批条件')
    expect(plan.source).toBe('deterministic')
  })

  it('解析纯 JSON 和 Markdown fence，拒绝非 JSON', () => {
    expect(extractJson('```json\n{"mode":"deep"}\n```')).toEqual({ mode: 'deep' })
    expect(extractJson('结果如下： {"ok":true}')).toEqual({ ok: true })
    expect(extractJson('not json')).toBeNull()
  })

  it('模型规划经过 schema 校验，且原始问题不会被模型拆分丢失', async () => {
    const db = openDb({ path: ':memory:' })
    const cfg = testConfig({
      chatModel: 'reasoner',
      chatBaseUrl: 'https://chat.test/v1',
      chatKey: 'secret'
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        mode: 'deep',
        intent: 'multi_hop',
        subQueries: ['甲方案审批条件', '乙方案审批条件'],
        requiredFacts: ['甲方案条件', '乙方案条件']
      }) } }]
    }), { status: 200 })))

    const plan = await planQuestion(db, cfg, '甲乙方案分别需要什么审批？', 'auto')
    expect(plan.source).toBe('model')
    expect(plan.mode).toBe('deep')
    expect(plan.subQueries).toEqual([
      '甲乙方案分别需要什么审批？',
      '甲方案审批条件',
      '乙方案审批条件'
    ])
    db.close()
  })

  it('零证据时模型只能建议补检，不能把问题凭空判为有依据', async () => {
    const db = openDb({ path: ':memory:' })
    const cfg = testConfig({
      chatModel: 'reasoner',
      chatBaseUrl: 'https://chat.test/v1',
      chatKey: 'secret'
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        sufficient: true,
        confidence: 0.99,
        coveredFacts: ['预算金额'],
        missingFacts: ['预算金额'],
        followUpQueries: ['月球基地预算审批金额']
      }) } }]
    }), { status: 200 })))
    const result = await assessEvidence(
      db,
      cfg,
      '月球基地预算是多少？',
      fallbackPlan('月球基地预算是多少？', 'deep'),
      []
    )
    expect(result).toMatchObject({
      sufficient: false,
      confidence: 0,
      reason: 'none',
      source: 'model',
      followUpQueries: ['月球基地预算审批金额']
    })
    db.close()
  })
})

describe('claim 事实边界', () => {
  it('接受引用直接支持且数字、义务极性一致的 claim', () => {
    const result = validateClaimsDeterministically([
      { text: '报销金额不得超过五百元。', citationIds: ['cit-1'] }
    ], evidence)
    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('将“最多”和“不得超过”视为同一上限极性', () => {
    const result = validateClaimsDeterministically([
      { text: '报销金额最多为五百元。', citationIds: ['cit-1'] }
    ], evidence)
    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('拒绝模型擅自修改数字', () => {
    const result = validateClaimsDeterministically([
      { text: '报销金额不得超过六百元。', citationIds: ['cit-1'] }
    ], evidence)
    expect(result.valid).toBe(false)
    expect(result.issues[0]?.reason).toContain('六百元')
  })

  it('拒绝引用没有直接支持的义务/否定极性', () => {
    const result = validateClaimsDeterministically([
      { text: '报销金额可以超过五百元。', citationIds: ['cit-1'] }
    ], evidence)
    expect(result.valid).toBe(false)
    expect(result.issues[0]?.reason).toContain('极性')
  })

  it('语义审查返回 contradicted 时整份生成答案失败关闭', async () => {
    const db = openDb({ path: ':memory:' })
    const cfg = testConfig({
      chatModel: 'reasoner',
      chatBaseUrl: 'https://chat.test/v1',
      chatKey: 'secret'
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answerComplete: true,
        missingRequiredFacts: [],
        verdicts: [{ claimIndex: 0, verdict: 'contradicted', reason: '主体不一致' }]
      }) } }]
    }), { status: 200 })))
    const result = await verifyClaims(
      db,
      cfg,
      '报销规则是什么？',
      ['报销规则是什么？'],
      [{ text: '报销金额不得超过五百元。', citationIds: ['cit-1'] }],
      evidence
    )
    expect(result.valid).toBe(false)
    expect(result.issues).toEqual([{ claimIndex: 0, reason: '主体不一致' }])
    db.close()
  })

  it('所有 claim 都真实但没有完整回答必要事实时仍拒绝生成答案', async () => {
    const db = openDb({ path: ':memory:' })
    const cfg = testConfig({
      chatModel: 'reasoner',
      chatBaseUrl: 'https://chat.test/v1',
      chatKey: 'secret'
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answerComplete: false,
        missingRequiredFacts: ['审批级数'],
        verdicts: [{ claimIndex: 0, verdict: 'supported', reason: '' }]
      }) } }]
    }), { status: 200 })))
    const result = await verifyClaims(
      db,
      cfg,
      '报销限额和审批级数是什么？',
      ['报销限额', '审批级数'],
      [{ text: '报销金额不得超过五百元。', citationIds: ['cit-1'] }],
      evidence
    )
    expect(result.valid).toBe(false)
    expect(result.issues[0]?.reason).toContain('审批级数')
    db.close()
  })
})
