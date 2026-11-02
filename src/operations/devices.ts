import type { DB } from '../db/index.js'

export function listDevices(db: DB, userId?: string): any[] {
  return db.prepare(`WITH contacts AS (
    SELECT user_id,device_id,MAX(created_at) AS seen FROM refresh_tokens GROUP BY user_id,device_id
    UNION ALL SELECT user_id,device_id,synced_at FROM sync_cursors
    UNION ALL SELECT user_id,device_id,COALESCE(last_used_at,created_at) FROM api_keys WHERE device_id IS NOT NULL
    UNION ALL SELECT user_id,device_id,last_seen_at FROM client_devices
  ), devices AS (SELECT user_id,device_id,MAX(seen) AS lastContact FROM contacts GROUP BY user_id,device_id)
  SELECT d.user_id AS userId,u.display_name AS displayName,u.username,u.status AS userStatus,
    d.device_id AS deviceId,d.lastContact,c.name,c.version,c.platform,c.last_seen_at AS heartbeatAt,
    c.policy_version AS policyVersion,c.config_revision AS configRevision,c.receipt_json AS receiptJson,
    c.capabilities_json AS capabilitiesJson,c.skill_receipt_at AS skillReceiptAt,c.skill_receipts_complete AS skillReceiptsComplete
  FROM devices d JOIN users u ON u.id=d.user_id
  LEFT JOIN client_devices c ON c.user_id=d.user_id AND c.device_id=d.device_id
  ${userId ? 'WHERE d.user_id=?' : ''} ORDER BY d.lastContact DESC LIMIT 2000`).all(...(userId ? [userId] : []))
}

export function deviceCoverage(items: any[]) {
  const reported = items.filter(d => d.heartbeatAt != null).length
  const receipts = items.filter(d => d.receiptJson != null).length
  return { total: items.length, reported, receipts, online: items.filter(d => d.heartbeatAt && Date.now() - d.heartbeatAt < 180000).length }
}
