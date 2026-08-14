/**
 * 结构感知分块。
 *
 * 分块是"静默失败点":切坏了不会报错,只是答案质量莫名变差。四条规则
 * 按优先级:
 *   1. 结构优先 —— 按标题/页/段落切,不是先按字数硬切;
 *   2. 表格整体保留 —— 超长表格按行分批,每批重复表头,否则行与列名脱钩;
 *   3. 列表不断裂 —— 列表项留在同一 chunk;
 *   4. 标题链注入 —— chunk 文本前缀拼上标题链再做嵌入。孤立片段常缺主语
 *      ("标准是 500 元" 少了"住宿"),标题链把上下文补回来,对召回提升明显。
 */

export type BlockKind =
  | 'heading'
  | 'para'
  | 'table'
  | 'list'
  | 'code'
  | 'caption'
  | 'transcript'

export interface Block {
  kind: BlockKind
  text: string
  /** heading 层级,1 最高。 */
  level?: number
  page?: number
  startMs?: number
  endMs?: number
  /** 表格首行(表头),分批时重复注入。 */
  tableHeader?: string
}

export interface ChunkDraft {
  text: string
  /** 供嵌入使用的文本:标题链 + 正文。 */
  embedText: string
  heading: string
  page: number | null
  startMs: number | null
  endMs: number | null
  modality: 'text' | 'caption' | 'transcript'
  tokenCount: number
}

export interface ChunkOptions {
  targetTokens?: number
  maxTokens?: number
  /** 表格允许更大,拆表比超预算更有害。 */
  maxTableTokens?: number
  overlapTokens?: number
}

const DEFAULTS = {
  targetTokens: 512,
  maxTokens: 1024,
  maxTableTokens: 2048,
  overlapTokens: 64
}

function estimate(text: string): number {
  let cjk = 0
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) cjk++
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

function modalityOf(kind: BlockKind): ChunkDraft['modality'] {
  if (kind === 'caption') return 'caption'
  if (kind === 'transcript') return 'transcript'
  return 'text'
}

export function chunkBlocks(blocks: Block[], opts: ChunkOptions = {}): ChunkDraft[] {
  const o = { ...DEFAULTS, ...opts }
  const out: ChunkDraft[] = []

  // 标题栈:维护当前所处的标题链。
  const headingStack: { level: number; text: string }[] = []
  let buf: Block[] = []

  const headingChain = (): string =>
    headingStack.map((h) => h.text).join(' > ')

  const flush = (): void => {
    if (buf.length === 0) return
    const chain = headingChain()
    const text = buf.map((b) => b.text).join('\n')
    const pages = buf.map((b) => b.page).filter((p): p is number => p != null)
    const starts = buf.map((b) => b.startMs).filter((v): v is number => v != null)
    const ends = buf.map((b) => b.endMs).filter((v): v is number => v != null)

    out.push({
      text,
      embedText: chain ? `${chain}\n${text}` : text,
      heading: chain,
      page: pages.length ? pages[0] : null,
      startMs: starts.length ? Math.min(...starts) : null,
      endMs: ends.length ? Math.max(...ends) : null,
      modality: modalityOf(buf[0].kind),
      tokenCount: estimate(text)
    })
    buf = []
  }

  for (const block of blocks) {
    if (block.kind === 'heading') {
      flush()
      const level = block.level ?? 1
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop()
      }
      headingStack.push({ level, text: block.text })
      continue
    }

    // 表格与代码独立成块,不与其他内容混合。
    if (block.kind === 'table' || block.kind === 'code') {
      flush()
      const limit = block.kind === 'table' ? o.maxTableTokens : o.maxTokens
      if (estimate(block.text) <= limit) {
        buf = [block]
        flush()
      } else {
        for (const part of splitTable(block, limit)) {
          buf = [part]
          flush()
        }
      }
      continue
    }

    const bufTokens = buf.reduce((s, b) => s + estimate(b.text), 0)
    const blockTokens = estimate(block.text)

    // 单块就超上限:自身再切,但列表项与转写段落尽量整段保留。
    if (blockTokens > o.maxTokens) {
      flush()
      for (const piece of splitLongText(block.text, o.targetTokens, o.overlapTokens)) {
        buf = [{ ...block, text: piece }]
        flush()
      }
      continue
    }

    if (bufTokens + blockTokens > o.targetTokens && bufTokens > 0) {
      flush()
    }
    buf.push(block)
  }
  flush()

  return out.filter((c) => c.text.trim().length > 0)
}

/** 表格按行分批,每批重复表头。 */
function splitTable(block: Block, limitTokens: number): Block[] {
  const lines = block.text.split('\n')
  const header = block.tableHeader ?? lines[0] ?? ''
  const body = block.tableHeader ? lines : lines.slice(1)

  const out: Block[] = []
  let batch: string[] = []
  let tokens = estimate(header)

  for (const line of body) {
    const t = estimate(line)
    if (tokens + t > limitTokens && batch.length > 0) {
      out.push({ ...block, text: [header, ...batch].join('\n') })
      batch = []
      tokens = estimate(header)
    }
    batch.push(line)
    tokens += t
  }
  if (batch.length) out.push({ ...block, text: [header, ...batch].join('\n') })
  return out
}

/** 长文本按句边界切,块间保留重叠以免切断跨句语义。 */
function splitLongText(
  text: string,
  targetTokens: number,
  overlapTokens: number
): string[] {
  const sentences = text.split(/(?<=[。！？!?\n])/).filter((s) => s.trim())
  const out: string[] = []
  let cur: string[] = []
  let tokens = 0

  for (const s of sentences) {
    const t = estimate(s)
    if (tokens + t > targetTokens && cur.length > 0) {
      out.push(cur.join(''))
      // 用上一块尾部做重叠
      const tail: string[] = []
      let tailTokens = 0
      for (let i = cur.length - 1; i >= 0 && tailTokens < overlapTokens; i--) {
        tail.unshift(cur[i])
        tailTokens += estimate(cur[i])
      }
      cur = tail
      tokens = tailTokens
    }
    cur.push(s)
    tokens += t
  }
  if (cur.length) out.push(cur.join(''))
  return out.length ? out : [text]
}
