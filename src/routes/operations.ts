import JSZip from 'jszip';
import { assetCount, createFullBackup } from '../operations/backup.js';
import { deriveKey, decryptSecret } from '../crypto.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, fail } from '../reply.js';
import { requireAdmin, requireCurator, type AuthedRequest } from '../auth/jwt.js';
import { loadManagementContext } from '../auth/scopes.js';
import { enqueueIngest } from '../kb/ingest/worker.js';
import { settings } from '../gateway/usage.js';
export function registerOperationsRoutes(app: FastifyInstance): void {
    const { db } = app.deps;
    const admin = { preHandler: [app.authenticate, requireAdmin] };
    const reviewer = { preHandler: [app.authenticate, requireCurator] };
    app.get('/api/v1/admin/system', admin, async (_req, reply) => {
        return reply.send(ok({ schemaVersion: db.pragma('user_version', { simple: true }), assets: await assetCount(app.deps.cfg.storageDir), calls: (db.prepare('SELECT COUNT(*) AS n FROM model_calls').get() as any).n, unsettled: (db.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE accounting_state!='complete'").get() as any).n, capabilities: { '语义嵌入': app.deps.embedder.semantic, '交叉编码精排': app.deps.reranker.crossEncoder, '图像理解': app.deps.vlmClient.configured, '文字识别': app.deps.ocrClient.configured, '音频转写': app.deps.transcriptionClient.configured } }));
    });
    let backingUp = false;
    app.post('/api/v1/admin/system/backup', admin, async (req, reply) => {
        if (backingUp)
            return reply.code(409).send(fail(4091, '已有备份正在生成'));
        backingUp = true;
        try {
            const bytes = await createFullBackup(db, app.deps.cfg.storageDir);
            app.audit(req, 'config_change', 'full_backup', { bytes: bytes.length });
            return reply.header('cache-control', 'no-store').header('content-type', 'application/zip').header('content-disposition', 'attachment; filename="echo-backup.zip"').send(bytes);
        }
        finally {
            backingUp = false;
        }
    });
    app.post('/api/v1/admin/model-config/history/:id/restore', admin, async (req, reply) => {
        const { id } = req.params as {
            id: string;
        };
        const row = db.prepare('SELECT config_json AS config,gateway_json AS gateway FROM model_config_history WHERE id=?').get(id) as any;
        if (!row)
            return reply.code(404).send(fail(4041, '配置历史不存在'));
        const c = JSON.parse(row.config);
        if (!c)
            return reply.code(409).send(fail(4091, '此记录没有可恢复的数据库配置'));
        let key: string | undefined;
        try {
            key = c.chat_key_enc ? decryptSecret(c.chat_key_enc, deriveKey(app.deps.cfg.masterKey)) : undefined;
        }
        catch {
            return reply.code(409).send(fail(4091, '历史密钥无法解密'));
        }
        const res = await app.inject({ method: 'PUT', url: '/api/v1/admin/model-config', headers: { authorization: req.headers.authorization! }, payload: { chatProvider: c.chat_provider, chatModel: c.chat_model, chatBaseUrl: c.chat_base_url ?? undefined, chatKey: key, clearCredential: !c.chat_key_enc, embedModel: c.embed_model, embedDim: c.embed_dim, rerankModel: c.rerank_model ?? undefined, vlmModel: c.vlm_model ?? undefined } });
        if (res.statusCode !== 200)
            return reply.code(res.statusCode).send(res.json());
        const g = JSON.parse(row.gateway);
        db.prepare("UPDATE gateway_settings SET revision=revision+1,models_json=?,public_base_url=?,max_output_tokens=?,protocols=?,input_price=?,cached_price=?,output_price=?,currency=?,updated_at=? WHERE id='default'").run(g.models_json ?? '{}', g.public_base_url, g.max_output_tokens, g.protocols, g.input_price, g.cached_price, g.output_price, g.currency, Date.now());
        app.audit(req, 'config_change', id, { modelConfigRestored: true });
        return reply.send(ok({ updated: true }));
    });
    app.get('/api/v1/admin/enterprise-policy/history', admin, async (_req, reply) => reply.send(ok(db.prepare('SELECT version,snapshot_json AS snapshot,created_at AS createdAt FROM policy_history ORDER BY version DESC LIMIT 50').all())));
    app.post('/api/v1/admin/enterprise-policy/history/:version/restore', admin, async (req, reply) => {
        const row = db.prepare('SELECT snapshot_json AS snapshot FROM policy_history WHERE version=?').get((req.params as any).version) as any;
        if (!row)
            return reply.code(404).send(fail(4041, '策略版本不存在'));
        const result = await app.inject({ method: 'PUT', url: '/api/v1/admin/enterprise-policy', headers: { authorization: req.headers.authorization! }, payload: JSON.parse(row.snapshot) });
        return reply.code(result.statusCode).send(result.json());
    });
    app.get('/api/v1/submissions', { preHandler: app.authenticate }, async (req, reply) => {
        const p = z.object({ page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(req.query);
        if (!p.success)
            return reply.code(400).send(fail(4001, '查询参数错误'));
        const c = (req as AuthedRequest).claims;
        const sql = `SELECT id,'document' AS kind,title,state,review_note AS note,created_at AS createdAt,reviewed_at AS reviewedAt FROM document_submissions WHERE submitter_id=? AND hidden_by_submitter=0
     UNION ALL SELECT id,'memory' AS kind,substr(json_extract(payload,'$.content'),1,120) AS title,state,review_note AS note,created_at AS createdAt,reviewed_at AS reviewedAt FROM promotions WHERE submitter_id=?
     UNION ALL SELECT v.id,'skill' AS kind,f.name AS title,v.state,v.review_note AS note,v.created_at AS createdAt,v.reviewed_at AS reviewedAt FROM skill_versions v JOIN skill_families f ON f.id=v.family_id WHERE v.submitter_id=?`;
        const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(c.sub, c.sub, c.sub) as any).n;
        const items = db.prepare(`SELECT * FROM (${sql}) ORDER BY createdAt DESC,id LIMIT ? OFFSET ?`).all(c.sub, c.sub, c.sub, p.data.size, (p.data.page - 1) * p.data.size);
        return reply.send(ok({ items, total, ...p.data }));
    });
    const ctxFor = (req: any) => loadManagementContext(db, req.claims.sub, req.claims.role);
    for (const url of ['/api/v1/admin/workspace', '/api/v1/workspace']) {
    app.get(url, admin, async (req, reply) => {
        const ctx = ctxFor(req);
        ctx.scopeIds = (db.prepare("SELECT id FROM v_effective_scopes WHERE kind IN ('org','team')").all() as { id: string }[]).map(s => s.id).filter(id => ctx.scopeIds.includes(id));
        const placeholders = ctx.scopeIds.map(() => '?').join(',') || "''";
        const stats = db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN d.status='ready' THEN 1 ELSE 0 END) AS ready,SUM(CASE WHEN d.status='failed' THEN 1 ELSE 0 END) AS failed FROM documents d WHERE d.scope_id IN (${placeholders}) AND d.sensitivity<=? AND (d.family_id IS NULL OR d.id=(SELECT current_document_id FROM document_families f WHERE f.id=d.family_id))`).get(...ctx.scopeIds, ctx.clearance) as any;
        const memories = db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN valid_until<? THEN 1 ELSE 0 END) AS expired FROM org_memories WHERE status='active' AND scope_id IN (${placeholders}) AND sensitivity<=?`).get(Date.now(), ...ctx.scopeIds, ctx.clearance);
        const pending = {
            memories: (db.prepare(`SELECT COUNT(*) AS n FROM promotions WHERE state='pending' AND target_scope IN (${placeholders})`).get(...ctx.scopeIds) as any).n,
            documents: (db.prepare(`SELECT COUNT(*) AS n FROM document_submissions WHERE state='pending' AND target_scope IN (${placeholders}) AND sensitivity<=?`).get(...ctx.scopeIds, ctx.clearance) as any).n,
            skills: (db.prepare(`SELECT COUNT(*) AS n FROM skill_versions v JOIN skill_families f ON f.id=v.family_id WHERE v.state='pending' AND f.scope_id IN (${placeholders})`).get(...ctx.scopeIds) as any).n
        };
        const recent = db.prepare(`SELECT d.id,d.title,d.status,d.updated_at AS updatedAt FROM documents d WHERE d.scope_id IN (${placeholders}) AND d.sensitivity<=? AND d.status!='archived' AND (d.family_id IS NULL OR d.id=(SELECT current_document_id FROM document_families f WHERE f.id=d.family_id)) ORDER BY d.updated_at DESC LIMIT 6`).all(...ctx.scopeIds, ctx.clearance);
        const safetyCounts = (condition: string) => (db.prepare(`SELECT COUNT(*) AS n FROM (
          SELECT target_scope AS scope_id,sensitivity,state,scan_status FROM document_submissions
          UNION ALL SELECT f.scope_id,0,v.state,v.scan_status FROM skill_versions v JOIN skill_families f ON f.id=v.family_id
          UNION ALL SELECT target_scope,COALESCE(json_extract(payload,'$.sensitivity'),0),state,scan_status FROM promotions
        ) WHERE scope_id IN (${placeholders}) AND sensitivity<=? AND ${condition}`).get(...ctx.scopeIds,ctx.clearance) as any).n;
        const operations = {
            safetyPending: safetyCounts("state='pending'"),
            safetyFailed: safetyCounts("scan_status='failed'"),
            activeUsers: (db.prepare("SELECT COUNT(*) AS n FROM users WHERE status='active'").get() as any).n,
            failedJobs: (db.prepare(`SELECT COUNT(*) AS n FROM ingest_jobs j JOIN documents d ON d.id=j.doc_id WHERE j.state='failed' AND d.scope_id IN (${placeholders}) AND d.sensitivity<=?`).get(...ctx.scopeIds, ctx.clearance) as any).n,
            unsettledCalls: (db.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE accounting_state IN ('unknown','partial')").get() as any).n,
            openMaintenance: (db.prepare("SELECT COUNT(*) AS n FROM maintenance_tasks WHERE state!='closed'").get() as any).n
        };
        return reply.send(ok({ documents: stats, memories, pending, recent, operations, updatedAt: Date.now() }));
    });
    }
    app.get('/api/v1/admin/jobs', reviewer, async (req, reply) => {
        const p = z.object({ page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(100).default(25), state: z.enum(['queued', 'running', 'failed', 'done']).optional() }).safeParse(req.query);
        if (!p.success)
            return reply.code(400).send(fail(4001, '查询参数错误'));
        const ctx = ctxFor(req);
        const where = `d.scope_id IN (${ctx.scopeIds.map(() => '?').join(',') || "''"}) AND d.sensitivity<=?` + (p.data.state ? ' AND j.state=?' : '');
        const args = [...ctx.scopeIds, ctx.clearance, ...(p.data.state ? [p.data.state] : [])];
        const total = (db.prepare(`SELECT COUNT(*) AS n FROM ingest_jobs j JOIN documents d ON d.id=j.doc_id WHERE ${where}`).get(...args) as any).n;
        const items = db.prepare(`SELECT j.id,j.doc_id AS docId,d.title,j.stage,j.state,j.attempts,j.last_error AS lastError,j.lease_until AS leaseUntil,j.updated_at AS updatedAt FROM ingest_jobs j JOIN documents d ON d.id=j.doc_id WHERE ${where} ORDER BY j.updated_at DESC LIMIT ? OFFSET ?`).all(...args, p.data.size, (p.data.page - 1) * p.data.size);
        return reply.send(ok({ items, total, ...p.data }));
    });
    app.post('/api/v1/admin/jobs/:id/retry', reviewer, async (req, reply) => {
        const { id } = req.params as {
            id: string;
        };
        const ctx = ctxFor(req);
        const job = db.prepare('SELECT j.*,d.scope_id AS scopeId,d.sensitivity,d.status FROM ingest_jobs j JOIN documents d ON d.id=j.doc_id WHERE j.id=?').get(id) as any;
        if (!job || !ctx.scopeIds.includes(job.scopeId) || job.sensitivity > ctx.clearance)
            return reply.code(404).send(fail(4041, '任务不存在'));
        if (job.state !== 'failed')
            return reply.code(409).send(fail(4091, '仅失败任务可重试'));
        if (job.status === 'archived')
            return reply.code(409).send(fail(4091, '已归档文档不可重试'));
        const next = enqueueIngest(db, job.doc_id);
        app.audit(req, 'doc_reindex', job.doc_id, { previousJob: id });
        return reply.send(ok({ id: next }));
    });
    app.post('/api/v1/client/heartbeat', { preHandler: app.authenticate }, async (req, reply) => {
        const p = z.object({ deviceId: z.string().min(1).max(200).optional(), name: z.string().max(100).optional(), version: z.string().max(80).optional(), platform: z.string().max(80).optional(), policyVersion: z.number().int().min(0).optional(), configRevision: z.number().int().min(0).optional(), skills: z.array(z.object({ skillId: z.string().max(200), versionId: z.string().max(200), state: z.enum(['installed', 'removed', 'failed']), error: z.string().max(300).optional() })).max(1000).optional() }).safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, '客户端状态格式错误'));
        const c = (req as AuthedRequest).claims;
        const v = p.data;
        const device = c.device ?? v.deviceId;
        if (!device || (c.device && v.deviceId && c.device !== v.deviceId))
            return reply.code(403).send(fail(4031, '设备身份不匹配'));
        const policy = (db.prepare("SELECT version FROM enterprise_policy WHERE id='default'").get() as any).version;
        if ((v.policyVersion ?? 0) > policy || (v.configRevision ?? 0) > settings(db).revision)
            return reply.code(400).send(fail(4001, '回执版本高于当前发布版本'));
        db.prepare(`INSERT INTO client_devices(user_id,device_id,name,version,platform,last_seen_at,policy_version,config_revision,receipt_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET name=COALESCE(excluded.name,client_devices.name),version=COALESCE(excluded.version,client_devices.version),platform=COALESCE(excluded.platform,client_devices.platform),last_seen_at=excluded.last_seen_at,policy_version=COALESCE(excluded.policy_version,client_devices.policy_version),config_revision=COALESCE(excluded.config_revision,client_devices.config_revision),receipt_json=COALESCE(excluded.receipt_json,client_devices.receipt_json)`).run(c.sub, device, v.name ?? null, v.version ?? null, v.platform ?? null, Date.now(), v.policyVersion ?? null, v.configRevision ?? null, v.skills ? JSON.stringify(v.skills) : null);
        return reply.send(ok({ serverTime: Date.now(), policyVersion: policy, configRevision: settings(db).revision }));
    });
    app.get('/api/v1/admin/devices', admin, async (_req, reply) => {
        // A successful authenticated sync/config download is a contact, not an installation receipt.
        const rows = db.prepare(`WITH contacts AS (
    SELECT user_id,device_id,MAX(created_at) AS seen FROM refresh_tokens GROUP BY user_id,device_id
    UNION ALL SELECT user_id,device_id,synced_at FROM sync_cursors
    UNION ALL SELECT user_id,device_id,COALESCE(last_used_at,created_at) FROM api_keys WHERE device_id IS NOT NULL
    UNION ALL SELECT user_id,device_id,last_seen_at FROM client_devices
  ), devices AS (SELECT user_id,device_id,MAX(seen) AS lastContact FROM contacts GROUP BY user_id,device_id)
  SELECT d.user_id AS userId,u.display_name AS displayName,u.username,u.status AS userStatus,d.device_id AS deviceId,d.lastContact,c.name,c.version,c.platform,c.last_seen_at AS heartbeatAt,c.policy_version AS policyVersion,c.config_revision AS configRevision,c.receipt_json AS receiptJson FROM devices d JOIN users u ON u.id=d.user_id LEFT JOIN client_devices c ON c.user_id=d.user_id AND c.device_id=d.device_id ORDER BY d.lastContact DESC LIMIT 2000`).all();
        return reply.send(ok({ items: rows, policyVersion: (db.prepare("SELECT version FROM enterprise_policy WHERE id='default'").get() as any).version, configRevision: settings(db).revision }));
    });
    app.post('/api/v1/admin/devices/revoke', admin, async (req, reply) => {
        const p = z.object({ userId: z.string(), deviceId: z.string() }).safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, '参数错误'));
        const { revokeDeviceTokens } = await import('../auth/jwt.js');
        revokeDeviceTokens(db, p.data.userId, p.data.deviceId);
        app.audit(req, 'user_change', p.data.userId, { deviceRevoked: p.data.deviceId });
        return reply.send(ok({ revoked: true }));
    });
    app.get('/api/v1/admin/maintenance', admin, async (_req, reply) => {
        return reply.send(ok(db.prepare(`SELECT t.*,u.display_name AS ownerName FROM maintenance_tasks t LEFT JOIN users u ON u.id=t.owner_id ORDER BY t.updated_at DESC LIMIT 1000`).all()));
    });
    app.post('/api/v1/admin/maintenance', admin, async (req, reply) => {
        const p = z.object({ question: z.string().trim().min(1).max(4000), sourceEventId: z.string().optional(), ownerId: z.string().nullable().optional(), note: z.string().max(4000).optional() }).safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, '维护任务参数错误'));
        if (p.data.ownerId && !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(p.data.ownerId))
            return reply.code(400).send(fail(4001, '负责人不存在或已禁用'));
        const id = randomUUID();
        db.prepare('INSERT INTO maintenance_tasks(id,question,source_event_id,owner_id,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, p.data.question, p.data.sourceEventId ?? null, p.data.ownerId ?? null, p.data.note ?? null, (req as AuthedRequest).claims.sub, Date.now(), Date.now());
        app.audit(req, 'maintenance_change', id, { created: true });
        return reply.send(ok({ id }));
    });
    app.patch('/api/v1/admin/maintenance/:id', admin, async (req, reply) => {
        const p = z.object({ version: z.number().int(), state: z.enum(['open', 'working', 'verified', 'closed']), note: z.string().max(4000), resultAssetId: z.string().nullable().optional(), ownerId: z.string().nullable().optional() }).safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, '任务参数错误'));
        const { id } = req.params as {
            id: string;
        };
        const row = db.prepare('SELECT * FROM maintenance_tasks WHERE id=?').get(id) as any;
        if (!row)
            return reply.code(404).send(fail(4041, '任务不存在'));
        if (row.version !== p.data.version)
            return reply.code(409).send(fail(4091, '任务已被其他人更新，请刷新'));
        if (p.data.state === 'closed' && row.state !== 'verified')
            return reply.code(409).send(fail(4091, '请先复测并标记验证通过，再关闭任务'));
        if (['verified', 'closed'].includes(p.data.state) && !p.data.note.trim())
            return reply.code(400).send(fail(4001, '请填写复测记录'));
        if (p.data.ownerId && !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(p.data.ownerId))
            return reply.code(400).send(fail(4001, '负责人不存在或已禁用'));
        db.prepare('UPDATE maintenance_tasks SET state=?,note=?,result_asset_id=?,owner_id=?,updated_at=?,version=version+1 WHERE id=? AND version=?').run(p.data.state, p.data.note, p.data.resultAssetId ?? row.result_asset_id, p.data.ownerId === undefined ? row.owner_id : p.data.ownerId, Date.now(), id, p.data.version);
        app.audit(req, 'maintenance_change', id, { state: p.data.state });
        return reply.send(ok({ updated: true }));
    });
    app.get('/api/v1/admin/skills', reviewer, async (req, reply) => {
        const ctx = ctxFor(req);
        const rows = db.prepare(`SELECT f.id,f.slug,f.name,f.description,f.state,f.mandatory,f.allow_personal_override AS allowPersonalOverride,f.scope_id AS scopeId,s.name AS scopeName,s.kind AS scopeKind,f.updated_at AS updatedAt,v.id AS versionId,v.version,v.scan_status AS scanStatus,v.scan_report_json AS scanReportJson,v.manifest_json AS manifestJson,v.changelog,
    (SELECT COUNT(*) FROM skill_usage_events e WHERE e.skill_id=f.id) AS uses,
    (SELECT COUNT(*) FROM skill_usage_events e WHERE e.skill_id=f.id AND e.result='failed') AS failures
    FROM skill_families f JOIN v_effective_scopes s ON s.id=f.scope_id LEFT JOIN skill_versions v ON v.id=f.current_version_id WHERE f.scope_id IN (${ctx.scopeIds.map(() => '?').join(',') || "''"}) ORDER BY f.updated_at DESC LIMIT 2000`).all(...ctx.scopeIds);
        return reply.send(ok(rows));
    });
    app.get('/api/v1/admin/skills/:id/versions', reviewer, async (req, reply) => {
        const ctx = ctxFor(req);
        const { id } = req.params as {
            id: string;
        };
        const family = db.prepare('SELECT scope_id AS scopeId FROM skill_families WHERE id=?').get(id) as any;
        if (!family || !ctx.scopeIds.includes(family.scopeId))
            return reply.code(404).send(fail(4041, '技能不存在'));
        return reply.send(ok(db.prepare(`SELECT id AS versionId,version,state,scan_status AS scanStatus,scan_report_json AS scanReportJson,manifest_json AS manifestJson,changelog,created_at AS createdAt,published_at AS publishedAt,review_note AS reviewNote FROM skill_versions WHERE family_id=? ORDER BY created_at DESC`).all(id)));
    });
    app.get('/api/v1/admin/skills/:id/versions/:versionId/source', reviewer, async (req, reply) => {
        const ctx = ctxFor(req), { id, versionId } = req.params as {
            id: string;
            versionId: string;
        }, path = (req.query as {
            path?: string;
        }).path;
        const row = db.prepare(`SELECT f.scope_id AS scopeId,COALESCE(v.published_package_key,v.quarantine_package_key,v.package_key) AS packageKey FROM skill_versions v JOIN skill_families f ON f.id=v.family_id WHERE v.id=? AND f.id=?`).get(versionId, id) as any;
        if (!row || !ctx.scopeIds.includes(row.scopeId))
            return reply.code(404).send(fail(4041, '版本不存在'));
        const zip = await JSZip.loadAsync(await app.deps.storage.get(row.packageKey));
        const files = Object.values(zip.files).filter(f => !f.dir).map(f => f.name).sort();
        const selected = path ?? (files.includes('SKILL.md') ? 'SKILL.md' : files[0]);
        if (!selected || !files.includes(selected))
            return reply.code(404).send(fail(4041, '文件不存在'));
        if (!/\.(?:md|txt|json|ya?ml|js|ts|py|sh|toml|csv)$/i.test(selected))
            return reply.send(ok({ files, path: selected, text: null, reason: '此文件不支持文本预览，请下载技能包查看' }));
        const bytes = await zip.file(selected)!.async('nodebuffer');
        app.audit(req, 'skill_review_download', id, { versionId, path: selected, preview: true });
        return reply.header('cache-control', 'no-store').send(ok({ files, path: selected, text: bytes.subarray(0, 200000).toString('utf8'), truncated: bytes.length > 200000 }));
    });
    app.get('/api/v1/notifications', { preHandler: app.authenticate }, async (req, reply) => {
        const claims = (req as AuthedRequest).claims;
        const ctx = ctxFor(req);
        const args = [...ctx.scopeIds];
        const marks = args.map(() => '?').join(',') || "''";
        const entries: any[] = [];
        const own = db.prepare(`SELECT id,title AS label,state,review_note AS note,COALESCE(reviewed_at,created_at) AS at FROM document_submissions WHERE submitter_id=? AND state IN ('approved','rejected','scan_failed','ingest_failed') ORDER BY at DESC LIMIT 50`).all(claims.sub) as any[];
        own.forEach(r => entries.push({ id: `doc-${r.id}-${r.state}`, title: `文档「${r.label}」${r.state === 'approved' ? '已通过' : '需要处理'}`, description: r.note ?? '', at: r.at, path: claims.role === 'member' ? '/submissions' : '/documents' }));
        const promotions = db.prepare("SELECT id,state,review_note AS note,COALESCE(reviewed_at,created_at) AS at FROM promotions WHERE submitter_id=? AND state IN ('approved','rejected') ORDER BY at DESC LIMIT 50").all(claims.sub) as any[];
        promotions.forEach(r => entries.push({ id: `memory-${r.id}-${r.state}`, title: `经验提交${r.state === 'approved' ? '已通过' : '已退回'}`, description: r.note ?? '', at: r.at, path: claims.role === 'member' ? '/submissions' : '/memories' }));
        if (claims.role !== 'member') {
            const n = (db.prepare(`SELECT COUNT(*) AS n FROM document_submissions WHERE state='pending' AND target_scope IN (${marks}) AND sensitivity<=?`).get(...args, ctx.clearance) as any).n;
            if (n)
                entries.push({ id: `review-doc-${n}`, title: `${n} 份文档等待审核`, description: '查看扫描结果、预览内容并作出审核决定', at: Date.now(), path: '/review' });
            const failed = (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE status='failed' AND scope_id IN (${marks}) AND sensitivity<=?`).get(...args, ctx.clearance) as any).n;
            if (failed)
                entries.push({ id: `failed-${failed}`, title: `${failed} 份文档处理失败`, description: '查看错误原因并重试', at: Date.now(), path: '/jobs' });
        }
        const { quotaUsage } = await import('../gateway/usage.js');
        const dept = (db.prepare('SELECT department_id AS id FROM users WHERE id=?').get(claims.sub) as any)?.id;
        const quotaRules = db.prepare(`SELECT * FROM quota_rules WHERE enabled=1 ${claims.role === 'admin' ? '' : "AND (target_type='org' OR (target_type='user' AND target_id=?) OR (target_type='department' AND target_id=?) OR (target_type='key' AND target_id IN (SELECT id FROM api_keys WHERE user_id=?)))"}`).all(...(claims.role === 'admin' ? [] : [claims.sub, dept ?? '', claims.sub])) as any[];
        for (const q of quotaRules) {
            const u = quotaUsage(db, q);
            const ratio = Math.max(q.token_limit === null ? 0 : u.tokens / Math.max(1, q.token_limit), q.cost_limit === null ? 0 : u.cost / Math.max(.000001, q.cost_limit));
            if (ratio >= .8)
                entries.push({ id: `quota-${q.id}-${u.since}-${ratio >= 1 ? 'full' : 'near'}`, title: ratio >= 1 ? '模型用量已达到配额' : '模型用量即将达到配额', description: `当前周期已使用 ${u.tokens} Token（包含待核对预留）。`, at: q.updated_at, path: '/quotas' });
        }
        const reads = new Set((db.prepare('SELECT notification_id AS id FROM notification_reads WHERE user_id=?').all(claims.sub) as any[]).map(r => r.id));
        return reply.send(ok(entries.sort((a, b) => b.at - a.at).map(r => ({ ...r, read: reads.has(r.id) }))));
    });
    app.post('/api/v1/notifications/read', { preHandler: app.authenticate }, async (req, reply) => {
        const p = z.object({ ids: z.array(z.string().max(300)).max(200) }).safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, '参数错误'));
        db.transaction(() => { for (const id of p.data.ids)
            db.prepare('INSERT OR IGNORE INTO notification_reads VALUES(?,?,?)').run((req as AuthedRequest).claims.sub, id, Date.now()); })();
        return reply.send(ok({ updated: true }));
    });
    app.get('/api/v1/admin/model-config/history', admin, async (_req, reply) => {
        const rows = db.prepare('SELECT id,config_json AS config,gateway_json AS gateway,actor_id AS actorId,created_at AS createdAt FROM model_config_history ORDER BY created_at DESC LIMIT 50').all() as any[];
        return reply.send(ok(rows.map(r => { const c = JSON.parse(r.config); if (c)
            delete c.chat_key_enc; return { ...r, config: c, gateway: JSON.parse(r.gateway) }; })));
    });
}
