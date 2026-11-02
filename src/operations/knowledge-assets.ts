import type { DB } from '../db/index.js'
import type { AccessContext } from '../auth/scopes.js'

export const assetKinds = ['document', 'memory', 'skill'] as const
export type AssetKind = typeof assetKinds[number]
export const knowledgeAssetsSql = `
 SELECT 'document' AS kind,d.id,d.title,d.scope_id AS scopeId,d.sensitivity,d.owner_id AS ownerId,d.updated_at AS updatedAt
 FROM documents d JOIN document_families f ON f.current_document_id=d.id
 WHERE d.status='ready' AND f.state='active'
 UNION ALL SELECT 'memory',m.id,substr(m.content,1,160),m.scope_id,m.sensitivity,m.author_id,m.updated_at
 FROM org_memories m WHERE m.status='active' AND (m.valid_until IS NULL OR m.valid_until>CAST(strftime('%s','now') AS INTEGER)*1000)
 UNION ALL SELECT 'skill',f.id,f.name,f.scope_id,0,f.owner_id,f.updated_at
 FROM skill_families f WHERE f.state='active' AND f.current_version_id IS NOT NULL`

export function findKnowledgeAsset(db: DB, ctx: AccessContext, id: string, kind?: string): any | null {
  const row = db.prepare(`SELECT a.*,s.name AS scopeName,s.kind AS scopeKind FROM (${knowledgeAssetsSql}) a
    JOIN v_effective_scopes s ON s.id=a.scopeId WHERE a.id=? ${kind ? 'AND a.kind=?' : ''}`).get(id, ...(kind ? [kind] : [])) as any
  return row && row.scopeKind !== 'personal' && ctx.scopeIds.includes(row.scopeId) && row.sensitivity <= ctx.clearance ? row : null
}
