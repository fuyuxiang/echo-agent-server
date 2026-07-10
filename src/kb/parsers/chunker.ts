import type { ParserUnit } from './types.js'

interface Opts {
  maxChars?: number
  overlapChars?: number
}

const DEFAULTS = { maxChars: 800, overlapChars: 80 }

/** Prefer paragraph and sentence boundaries; copy the previous chunk tail into the next chunk for continuity. */
export function semanticChunk(units: ParserUnit[], opts?: Opts): ParserUnit[] {
  const { maxChars, overlapChars } = { ...DEFAULTS, ...opts }
  const out: ParserUnit[] = []

  for (const unit of units) {
    if (unit.text.length <= maxChars) {
      out.push(unit)
      continue
    }

    const parts = splitBySentences(unit.text, maxChars)
    let prevTail = ''
    for (const part of parts) {
      const chunkText = prevTail + part
      out.push({ text: chunkText, location: unit.location })
      prevTail = part.slice(-overlapChars)
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
    for (const segment of hardCut(m[0], max)) {
      if ((buf + segment).length > max && buf) {
        parts.push(buf)
        buf = ''
      }

      if (segment.length >= max) {
        parts.push(segment)
      } else {
        buf += segment
      }
    }
  }

  if (buf) parts.push(buf)
  return parts.length ? parts : hardCut(text, max)
}

function hardCut(text: string, max: number): string[] {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += max) {
    parts.push(text.slice(i, i + max))
  }
  return parts
}
