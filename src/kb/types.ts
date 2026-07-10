export type DocumentType = 'text' | 'docx' | 'pdf' | 'excel' | 'audio' | 'video'

export type DocumentStatus = 'pending' | 'parsing' | 'indexing' | 'ready' | 'failed'

export interface DocumentRow {
  id: string
  name: string
  type: DocumentType
  groupId: string
  sourcePath: string        // 落盘后路径
  hash: string              // sha256
  version: number
  status: DocumentStatus
  errorMessage: string | null
  uploaderId: string
  createdAt: number
  updatedAt: number
}

export interface LocationPageSection { kind: 'page_section'; page: number; section?: string }
export interface LocationSheetCell { kind: 'sheet_cell'; sheet: string; cellRange: string }
export interface LocationTimestamp { kind: 'timestamp'; startMs: number; endMs: number }
export interface LocationPlain { kind: 'plain'; offset: number; length: number }
export type Location =
  | LocationPageSection | LocationSheetCell | LocationTimestamp | LocationPlain

export interface KnowledgeUnitRow {
  id: string
  docId: string
  groupId: string
  location: Location
  text: string
  vectorRef: string          // = unit.id,留字段以便未来换索引
  createdAt: number
}

export interface Citation {
  unitId: string
  docId: string
  docName: string
  location: Location
  excerpt: string
}

export type Confidence = 'high' | 'medium' | 'low'

export interface AskResult {
  answer: string
  citations: Citation[]
  confidence: Confidence
  fallbackMaterialList?: { docId: string; docName: string }[]
}
