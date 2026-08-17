/**
 * XLSX 双表征解析器。
 *
 * 每个 sheet 输出两个 ParserUnit:
 *   - 一个 sheet 摘要(列名 + 行数)—— 用于"看库里有什么"的元数据检索;
 *   - 一个或多个行级 chunk —— 每行拼成可被 BM25 命中的短文本。
 *
 * 用 exceljs 流式读,避免大表把内存吃光。
 */

import ExcelJS from 'exceljs'
import type { Parser, ParserUnit } from './types.js'

export const xlsxParser: Parser = {
  sourceType: 'xlsx',
  async parse(buf: Buffer): Promise<ParserUnit[]> {
    const wb = new ExcelJS.Workbook()
    // 传 Buffer 而非文件路径,避免大文件临时落盘。
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    const units: ParserUnit[] = []

    wb.eachSheet((ws) => {
      const rows: unknown[][] = []
      ws.eachRow({ includeEmpty: false }, (row) => {
        const values = (row.values as unknown[]).slice(1) // exceljs 第一项是行号
        if (values.some((v) => v !== null && v !== undefined && String(v).trim() !== '')) {
          rows.push(values.map((v) => (v == null ? '' : String(v))))
        }
      })
      if (rows.length === 0) return
      const header = rows[0]
      const body = rows.slice(1)

      // 摘要:列名 + 行数 —— 给"列出某个 sheet 里有什么"用。
      units.push({
        text: [
          `Sheet: ${ws.name}`,
          `列(${header.length}): ${header.join(' | ')}`,
          `行数: ${body.length}`
        ].join('\n'),
        location: { kind: 'page_section', page: 1, section: 'sheet-summary' }
      })

      // 行级:每行一段,便于 BM25 在具体内容上命中。
      // 单 sheet 行数过多时分批,每批最多 50 行,避免单个 chunk 超长。
      const BATCH = 50
      for (let i = 0; i < body.length; i += BATCH) {
        const slice = body.slice(i, i + BATCH)
        const lines = slice.map((r, k) => {
          const pairs = r.map((v, j) => `${header[j] ?? `列${j + 1}`}=${v}`).join(', ')
          return `第${i + k + 1}行: ${pairs}`
        })
        units.push({
          text: [`Sheet: ${ws.name}`, ...lines].join('\n'),
          location: { kind: 'page_section', page: Math.floor(i / BATCH) + 2, section: 'sheet-rows' }
        })
      }
    })

    return units
  }
}
