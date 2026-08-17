import { readFile } from 'node:fs/promises'
import type { Block } from './chunk.js'
import type { SourceType } from '../types.js'
import { textParser } from '../parsers/text.js'
import { docxParser } from '../parsers/docx.js'
import { pptxParser } from '../parsers/pptx.js'
import { xlsxParser } from '../parsers/xlsx.js'
import { imageParser, imageCaptionParser } from '../parsers/image.js'
import { pdfParser } from '../parsers/pdf.js'
import { audioParser, videoParser, mediaParserFor } from '../parsers/media.js'
import type { ParserUnit } from '../parsers/types.js'

export interface ParseResult {
  blocks: Block[]
  /** 源文档页数,用于摄取后置校验(扫描件识别)。未知则 null。 */
  pageCount: number | null
}

/**
 * 把各解析器的 ParserUnit 归一为分块器要的 Block。
 *
 * 现有解析器产出的 location 是判别联合,这里把它摊平成 Block 的
 * page / startMs 字段 —— 分块器不该关心解析器的内部表示。
 */
function unitToBlock(u: ParserUnit): Block {
  const loc = u.location
  if (loc.kind === 'page_section') {
    // section 名形如 heading-1/heading-2:还原成标题块,让标题链可用。
    const m = /^heading-(\d)$/.exec(loc.section ?? '')
    if (m) {
      return { kind: 'heading', level: Number(m[1]), text: u.text, page: loc.page }
    }
    return {
      kind: loc.section === 'list-item' ? 'list' : 'para',
      text: u.text,
      page: loc.page
    }
  }
  if (loc.kind === 'timestamp') {
    return { kind: 'transcript', text: u.text, startMs: loc.startMs, endMs: loc.endMs }
  }
  if (loc.kind === 'sheet_cell') {
    return { kind: 'table', text: u.text }
  }
  return { kind: 'para', text: u.text }
}

/** Markdown 按标题层级切,保住标题链 —— 通用解析器会丢掉这个结构。 */
function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  let buf: string[] = []
  let inFence = false

  const flushPara = (): void => {
    const t = buf.join('\n').trim()
    if (t) blocks.push({ kind: 'para', text: t })
    buf = []
  }

  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      buf.push(line)
      if (!inFence) {
        blocks.push({ kind: 'code', text: buf.join('\n') })
        buf = []
      }
      continue
    }
    if (inFence) {
      buf.push(line)
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2].trim() })
      continue
    }
    // 表格:连续的 | 行聚成一块,避免表头与数据行被切散。
    if (/^\s*\|/.test(line)) {
      const prev = blocks[blocks.length - 1]
      if (prev?.kind === 'table' && buf.length === 0) {
        prev.text += `\n${line}`
      } else {
        flushPara()
        blocks.push({ kind: 'table', text: line, tableHeader: line })
      }
      continue
    }
    if (!line.trim()) {
      flushPara()
      continue
    }
    if (/^\s*[-*+]\s+|^\s*\d+\.\s+/.test(line)) {
      const prev = blocks[blocks.length - 1]
      if (prev?.kind === 'list' && buf.length === 0) {
        prev.text += `\n${line}`
        continue
      }
      flushPara()
      blocks.push({ kind: 'list', text: line })
      continue
    }
    buf.push(line)
  }
  flushPara()
  return blocks
}

export async function parseDocument(
  filePath: string,
  sourceType: SourceType,
  fileName: string,
  docId: string
): Promise<ParseResult> {
  const buf = await readFile(filePath)

  switch (sourceType) {
    case 'md': {
      const blocks = parseMarkdown(buf.toString('utf8'))
      return { blocks, pageCount: null }
    }
    case 'txt':
    case 'qa':
    case 'meeting': {
      const units = await textParser.parse(buf, { docId, fileName })
      return { blocks: units.map(unitToBlock), pageCount: null }
    }
    case 'docx': {
      const units = await docxParser.parse(buf, { docId, fileName })
      return { blocks: units.map(unitToBlock), pageCount: null }
    }
    case 'pptx': {
      const units = await pptxParser.parse(buf, { docId, fileName })
      return {
        blocks: units.map(unitToBlock),
        pageCount: new Set(units.map((u) =>
          u.location.kind === 'page_section' ? u.location.page : 0
        )).size || null
      }
    }
    case 'xlsx': {
      const units = await xlsxParser.parse(buf, { docId, fileName })
      return { blocks: units.map(unitToBlock), pageCount: null }
    }
    case 'image': {
      // 图片默认走 caption 通道:无 VLM 时产出占位 caption,后续接入真实
      // VLM 后这里改为 caption-only 路径。
      const units = await imageCaptionParser.parse(buf, { docId, fileName })
      return { blocks: units.map(unitToBlock), pageCount: null }
    }
    case 'audio': {
      const units = await audioParser.parse(buf, { docId, fileName })
      return { blocks: units.map(unitToBlock), pageCount: null }
    }
    case 'video': {
      const units = await videoParser.parse(buf, { docId, fileName })
      return { blocks: units.map(unitToBlock), pageCount: null }
    }
    case 'pdf': {
      const units = await pdfParser.parse(buf, { docId, fileName })
      const pages = new Set(
        units
          .map((u) => (u.location.kind === 'page_section' ? u.location.page : undefined))
          .filter((p): p is number => p != null)
      )
      return { blocks: units.map(unitToBlock), pageCount: pages.size || null }
    }
    default:
      throw new Error(`暂不支持的文档类型: ${sourceType}`)
  }
}

const EXT_MAP: Record<string, SourceType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.text': 'txt',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
  '.mp4': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.webm': 'video',
  '.avi': 'video'
}

export function sourceTypeFromName(fileName: string): SourceType | null {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return null
  return EXT_MAP[fileName.slice(dot).toLowerCase()] ?? null
}

export const SUPPORTED_EXTENSIONS = Object.keys(EXT_MAP)
