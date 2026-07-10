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