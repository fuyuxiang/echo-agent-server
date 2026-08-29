import { randomUUID } from 'node:crypto'
import type { DB } from '../db/index.js'

export interface CreateDocumentFamilyInput {
  scopeId: string
  title: string
  ownerId: string | null
  now?: number
}
/** 创建逻辑文档。物理版本只有 ready 后才会成为 current。 */
export function createDocumentFamily(
  db: DB,
  input: CreateDocumentFamilyInput
): string {
  const id = randomUUID()
  const now = input.now ?? Date.now()
  db.prepare(
    `INSERT INTO document_families
       (id, scope_id, canonical_title, owner_id, current_document_id,
        state, created_at, updated_at)
     VALUES (?,?,?,?,NULL,'active',?,?)`
  ).run(id, input.scopeId, input.title, input.ownerId, now, now)
  return id
}

/**
 * 摄取成功后的唯一发布点。新版本未 ready 前不会替换生产版本；切换与文档
 * 状态更新应放在调用方同一个 SQLite 事务中。
 */
export function activateDocumentVersion(db: DB, docId: string, now = Date.now()): void {
  const row = db
    .prepare(
      `SELECT family_id AS familyId, scope_id AS scopeId, title, owner_id AS ownerId
         FROM documents WHERE id = ?`
    )
    .get(docId) as
    | { familyId: string | null; scopeId: string; title: string; ownerId: string | null }
    | undefined
  if (!row) throw new Error(`文档不存在: ${docId}`)

  let familyId = row.familyId
  if (!familyId) {
    // 兼容迁移前或测试手工插入的文档。
    familyId = createDocumentFamily(db, {
      scopeId: row.scopeId,
      title: row.title,
      ownerId: row.ownerId,
      now
    })
    db.prepare('UPDATE documents SET family_id = ? WHERE id = ?').run(familyId, docId)
  }

  db.prepare(
    `UPDATE document_families
        SET current_document_id = ?, state = 'active', updated_at = ?
      WHERE id = ?`
  ).run(docId, now, familyId)
}

export function documentIsCurrent(db: DB, docId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM document_families
        WHERE current_document_id = ? AND state = 'active'`
    )
    .get(docId)
}

/** 删除当前版本时整个逻辑文档退出目录与检索；历史版本删除不影响 current。 */
export function archiveFamilyIfCurrent(db: DB, docId: string, now = Date.now()): void {
  db.prepare(
    `UPDATE document_families
        SET state = 'archived', current_document_id = NULL, updated_at = ?
      WHERE current_document_id = ?`
  ).run(now, docId)
}
