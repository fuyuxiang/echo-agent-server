/**
 * 解析器产出的位置信息。
 *
 * 与 chunks 表的 loc_page / loc_start_ms / loc_end_ms 对应 —— 引用溯源
 * 靠它跳转,缺失则引用不可点击。保留判别联合是为了让各解析器只声明自己
 * 真正知道的定位方式:PDF 知道页码,音视频知道时间戳,纯文本只有偏移。
 */
export interface LocationPageSection {
  kind: 'page_section'
  page?: number
  section?: string
}
export interface LocationSheetCell {
  kind: 'sheet_cell'
  sheet: string
  cellRange: string
}
export interface LocationTimestamp {
  kind: 'timestamp'
  startMs: number
  endMs: number
}
export interface LocationPlain {
  kind: 'plain'
  offset: number
  length: number
}

export type Location =
  | LocationPageSection
  | LocationSheetCell
  | LocationTimestamp
  | LocationPlain

/** documents.source_type 的取值,与 001_init.sql 的 CHECK 约束保持一致。 */
export type SourceType =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'md'
  | 'txt'
  | 'image'
  | 'audio'
  | 'video'
  | 'web'
  | 'qa'
  | 'meeting'

export type DocumentStatus =
  | 'pending'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed'
  | 'archived'
