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
      const section: SectionKind =
        b.tag === 'h1' ? 'heading-1' :
        b.tag === 'h2' ? 'heading-2' :
        b.tag === 'h3' ? 'heading-3' :
        b.tag === 'li'  ? 'list-item' : 'paragraph'
      return { text: b.text, location: { kind: 'page_section', section } }
    })
  }
}
