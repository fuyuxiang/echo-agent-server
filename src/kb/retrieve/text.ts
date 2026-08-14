/**
 * 文本处理:中文分词补偿与 FTS5 查询构造。
 *
 * FTS5 的 unicode61 分词器把 CJK 按单字切分,"报销审批" 变成四个独立字,
 * 检索"报销"会命中所有含"报"或"销"的文档,精确率崩塌。两种解法:
 *   (a) 编译带 jieba/simple 分词器的 SQLite 扩展 —— 效果好,但要自编译,
 *       部署时每个平台都得带一份 .so/.dylib;
 *   (b) 写入时额外存 bigram 化副本,查询时同样 bigram 化。
 * 这里取 (b):零额外依赖,索引体积约 1.8x。
 */

const CJK = /[一-鿿㐀-䶿]/

export function isCjk(ch: string): boolean {
  return CJK.test(ch)
}

/**
 * 把 CJK 连续段切成 bigram,非 CJK 原样保留。
 *   "报销审批" -> "报销 销审 审批"
 *   "XR2000 报销" -> "XR2000 报销"
 * 单字 CJK 段保留原字,否则"我"这类查询无法命中。
 */
export function toBigrams(text: string): string {
  const out: string[] = []
  let run: string[] = []

  const flush = (): void => {
    if (run.length === 0) return
    const s = run.join('')
    if (s.length === 1) {
      out.push(s)
    } else {
      for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
    }
    run = []
  }

  for (const ch of text) {
    if (isCjk(ch)) {
      run.push(ch)
    } else {
      flush()
      if (!/\s/.test(ch)) out.push(ch)
    }
  }
  flush()
  return out.join(' ')
}

/** 索引体:原文 + bigram 副本。原文让 ASCII 词精确匹配,副本救中文召回。 */
export function indexableText(text: string): string {
  const bigrams = toBigrams(text)
  return bigrams ? `${text} ${bigrams}` : text
}

// FTS5 特殊字符。不转义会让用户输入的引号/星号变成语法,导致 SQL 报错。
const FTS_SPECIAL = /["*():^-]/g

/**
 * 构造 FTS5 MATCH 查询串。
 *
 * 每个 token 用双引号包成短语,避免被解释为运算符;token 之间用 OR,
 * 因为 AND 在 bigram 化后过于严格(长查询几乎必然无结果)。
 * 精确率由后续的 RRF 融合与精排负责,召回阶段宁宽勿窄。
 */
export function buildFtsQuery(query: string): string {
  const cleaned = query.replace(FTS_SPECIAL, ' ').trim()
  if (!cleaned) return ''

  const tokens = new Set<string>()
  // ASCII 词整体保留(型号、缩写、工号靠它精确命中)
  for (const m of cleaned.matchAll(/[A-Za-z0-9_]+/g)) {
    if (m[0].length >= 2) tokens.add(m[0].toLowerCase())
  }
  // CJK 部分 bigram 化
  for (const bg of toBigrams(cleaned).split(/\s+/)) {
    if (bg && CJK.test(bg)) tokens.add(bg)
  }

  if (tokens.size === 0) return ''
  return [...tokens].map((t) => `"${t}"`).join(' OR ')
}

/** 粗略 token 估算:CJK 约 1 token/字,ASCII 约 1 token/4 字符。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) if (isCjk(ch)) cjk++
  return cjk + Math.ceil((text.length - cjk) / 4)
}
