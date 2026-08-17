/**
 * PPTX 解析器。
 *
 * 结构:
 *   - .pptx 是 zip,内含 ppt/slides/slide*.xml;
 *   - 每页正文来自 <a:t> 文本节点;
 *   - 标题占位符(<p:ph type="title|ctrTitle">)识别为一级标题,用于
 *     分块器保留标题链。
 *
 * 仅依赖 jszip + 简单正则,不引入大型 PPTX 库,降低依赖体积与版本风险。
 */

import JSZip from 'jszip'
import type { Parser, ParserUnit } from './types.js'

interface SlideInfo {
  page: number
  title?: string
  paragraphs: string[]
}

function extractSlideText(xml: string): { title?: string; paragraphs: string[] } {
  const paragraphs: string[] = []
  let title: string | undefined

  const spBlocks = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? []
  for (const sp of spBlocks) {
    const isTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(sp)
    const texts = [...sp.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, '')
    )
    const joined = texts.join('').trim()
    if (!joined) continue
    if (isTitle) title = (title ? `${title} / ` : '') + joined
    else paragraphs.push(joined)
  }
  return { title, paragraphs }
}

async function readSlides(buf: Buffer): Promise<SlideInfo[]> {
  const zip = await JSZip.loadAsync(buf)
  const slides: { page: number; xml: string }[] = []
  for (const path of Object.keys(zip.files)) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path)
    if (!m) continue
    const file = zip.files[path]
    if (file.dir) continue
    slides.push({ page: Number(m[1]), xml: await file.async('string') })
  }
  slides.sort((a, b) => a.page - b.page)
  return slides.map((s) => ({ page: s.page, ...extractSlideText(s.xml) }))
}

export const pptxParser: Parser = {
  sourceType: 'pptx',
  async parse(buf: Buffer): Promise<ParserUnit[]> {
    const slides = await readSlides(buf)
    const units: ParserUnit[] = []
    for (const s of slides) {
      const chunks: string[] = []
      if (s.title) chunks.push(`# ${s.title}`)
      for (const p of s.paragraphs) chunks.push(p)
      const text = chunks.join('\n\n').trim()
      if (!text) continue
      units.push({
        text,
        location: { kind: 'page_section', page: s.page, section: 'slide' }
      })
    }
    return units
  }
}
