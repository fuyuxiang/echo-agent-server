import { randomUUID } from 'node:crypto'
import type { DB } from '../db/index.js'

export interface DocumentFolder { id: string; name: string; scopeId: string; parentId: string | null }
export function findDocumentFolder(db: DB, id: string): DocumentFolder | undefined {
  return db.prepare('SELECT id,name,scope_id AS scopeId,parent_id AS parentId FROM document_folders WHERE id=?').get(id) as DocumentFolder | undefined
}

export function folderBreadcrumbs(db: DB, id: string): DocumentFolder[] {
  const result: DocumentFolder[] = []
  const visited = new Set<string>()
  let next: string | null = id
  while (next) {
    if (visited.has(next) || result.length >= 32) throw new Error('目录层级无效')
    visited.add(next)
    const folder = findDocumentFolder(db, next)
    if (!folder) throw new Error('目录不存在')
    result.unshift(folder)
    next = folder.parentId
  }
  return result
}

export function normalizeFolderPath(path: string): string {
  const parts = path.normalize('NFC').split('/')
  if (path.length > 1024 || parts.length > 9 || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[\\\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error('目录路径无效，请使用不超过 9 层的相对目录')
  }
  return parts.join('/')
}

/** All paths are validated before starting the transaction; retries merge the same destination. */
export function importDocumentFolders(db: DB, scopeId: string, parentId: string | null, paths: string[], userId: string) {
  const normalized = [...new Set(paths.map(normalizeFolderPath))]
  const existingDepth = parentId ? folderBreadcrumbs(db, parentId).length : 0
  if (normalized.some(path => existingDepth + path.split('/').length > 16)) throw new Error('目标目录层级过深')
  return db.transaction(() => {
    const folders = new Map<string, DocumentFolder>()
    for (const path of normalized) {
      let parent = parentId
      let prefix = ''
      for (const name of path.split('/')) {
        prefix = prefix ? `${prefix}/${name}` : name
        let folder = folders.get(prefix)
        if (!folder) {
          db.prepare('INSERT OR IGNORE INTO document_folders(id,scope_id,parent_id,name,created_by,created_at) VALUES (?,?,?,?,?,?)')
            .run(randomUUID(), scopeId, parent, name, userId, Date.now())
          folder = db.prepare('SELECT id,name,scope_id AS scopeId,parent_id AS parentId FROM document_folders WHERE scope_id=? AND parent_id IS ? AND name=?')
            .get(scopeId, parent, name) as DocumentFolder
          folders.set(prefix, folder)
        }
        parent = folder.id
      }
    }
    return [...folders].map(([path, folder]) => ({ ...folder, path }))
  })()
}
