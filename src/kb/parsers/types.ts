import type { Location } from '../types.js'

export interface ParserUnit {
  text: string
  location: Location
}

export interface Parser {
  /** Expected ext: txt/md/docx/pdf/xlsx/csv/mp3/wav/m4a/mp4 */
  parse(buf: Buffer, meta: { docId: string; fileName: string }): Promise<ParserUnit[]>
}
