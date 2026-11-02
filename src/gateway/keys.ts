import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { Config } from '../config.js';
import { deriveKey, encryptSecret, decryptSecret } from '../crypto.js';
export function keyHash(key: string): string { return createHash('sha256').update(key).digest('hex'); }
export function issueKey(db: DB, cfg: Config, userId: string, name: string, deviceId?: string, expiresAt?: number) {
    const user = db.prepare("SELECT token_version AS tv FROM users WHERE id=? AND status='active'").get(userId) as {
        tv: number;
    } | undefined;
    if (!user)
        throw new Error('账号不存在或已禁用');
    const key = randomBytes(16).toString('hex').toUpperCase();
    const id = randomUUID();
    db.prepare(`INSERT INTO api_keys(id,user_id,device_id,name,key_hash,key_enc,prefix,token_version,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, userId, deviceId ?? null, name, keyHash(key), encryptSecret(key, deriveKey(cfg.masterKey)), key.slice(0, 6), user.tv, Date.now(), expiresAt ?? null);
    return { id, key };
}
export function deviceKey(db: DB, cfg: Config, userId: string, deviceId: string): {
    id: string;
    key: string;
} {
    const row = db.prepare(`SELECT k.id,k.key_enc AS secret FROM api_keys k JOIN users u ON u.id=k.user_id
    WHERE k.user_id=? AND k.device_id=? AND k.revoked_at IS NULL AND k.token_version=u.token_version
    AND (k.expires_at IS NULL OR k.expires_at>?) ORDER BY k.created_at DESC LIMIT 1`).get(userId, deviceId, Date.now()) as {
        id: string;
        secret: string;
    } | undefined;
    if (row) {
        try {
            return { id: row.id, key: decryptSecret(row.secret, deriveKey(cfg.masterKey)) };
        }
        catch {
            db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=?').run(Date.now(), row.id);
        }
    }
    return issueKey(db, cfg, userId, `桌面端 · ${deviceId.slice(0, 48)}`, deviceId);
}
export function authenticateKey(db: DB, key: string) {
    const row = db.prepare(`SELECT k.id,k.user_id AS userId,k.device_id AS deviceId,u.role,u.token_version AS tv
    FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.key_hash=? AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at>?) AND k.token_version=u.token_version AND u.status='active'`).get(keyHash(key), Date.now()) as {
        id: string;
        userId: string;
        deviceId: string | null;
        role: 'admin' | 'curator' | 'member';
        tv: number;
    } | undefined;
    if (row)
        db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(Date.now(), row.id);
    return row;
}
export function gatewayBaseUrl(db: DB, origin: string): string {
    const row = db.prepare("SELECT public_base_url AS url FROM gateway_settings WHERE id='default'").get() as {
        url: string | null;
    };
    return (row.url?.trim() || `${origin}/api/v1/llm/v1`).replace(/\/+$/, '');
}
