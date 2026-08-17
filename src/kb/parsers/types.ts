import type { Location, SourceType } from '../types.js'

export interface ParserUnit {
  text: string
  location: Location
}

export interface Parser {
  /** 声明支持的文件类型,parseDocument 据此选择解析器。 */
  sourceType: SourceType
  /** Expected ext: txt/md/docx/pdf/xlsx/csv/mp3/wav/m4a/mp4 */
  parse(buf: Buffer, meta: { docId: string; fileName: string }): Promise<ParserUnit[]>
}
