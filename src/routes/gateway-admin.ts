import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, fail } from '../reply.js';
import { requireAdmin, type AuthedRequest } from '../auth/jwt.js';
import { issueKey, gatewayBaseUrl } from '../gateway/keys.js';
import { quotaUsage, settings, meteredFetch, recoverStaleCalls } from '../gateway/usage.js';
import { resolveChatConfig } from '../models/chat-config.js';
const keySchema = z.object({ userId: z.string().optional(), name: z.string().trim().min(1).max(80), expiresAt: z.number().int().positive().optional() });
const quotaSchema = z.object({ targetType: z.enum(['org', 'department', 'user', 'key']), targetId: z.string().min(1), window: z.enum(['day', 'month', 'rolling']), windowHours: z.number().int().min(1).max(8760).default(5), tokenLimit: z.number().int().min(0).nullable().default(null), costLimit: z.number().min(0).nullable().default(null), currency: z.enum(['CNY', 'USD']).default('CNY'), rpm: z.number().int().min(0).nullable().default(null), concurrency: z.number().int().min(0).nullable().default(null), action: z.enum(['block', 'warn']).default('block'), enabled: z.boolean().default(true) });
const settingsSchema = z.object({ publicBaseUrl: z.string().trim().default(''), models: z.object({ images: z.string().max(200).optional(), speech: z.string().max(200).optional(), transcription: z.string().max(200).optional() }).default({}), maxOutputTokens: z.number().int().min(1).max(262144), protocols: z.array(z.enum(['chat', 'responses', 'anthropic', 'images', 'speech', 'transcription'])).min(1), inputPrice: z.number().min(0).nullable(), cachedPrice: z.number().min(0).nullable(), outputPrice: z.number().min(0).nullable(), currency: z.enum(['CNY', 'USD']) });
const selectCall = `c.id,c.user_id AS userId,c.user_name AS username,u.display_name AS displayName,c.department_name AS departmentName,c.key_id AS keyId,c.device_id AS deviceId,c.task_id AS taskId,c.asset_id AS assetId,c.source,c.model,c.protocol,c.started_at AS startedAt,c.finished_at AS finishedAt,c.http_status AS httpStatus,c.outcome,c.accounting_state AS accountingState,c.input_tokens AS inputTokens,c.output_tokens AS outputTokens,c.cached_tokens AS cachedTokens,c.cache_write_tokens AS cacheWriteTokens,c.reasoning_tokens AS reasoningTokens,c.total_tokens AS totalTokens,c.reserved_tokens AS reservedTokens,c.cost_source AS costSource,c.estimated_cost AS estimatedCost,c.currency,c.price_revision AS priceRevision,c.upstream_request_id AS upstreamRequestId,c.error_code AS errorCode,c.units_json AS unitsJson`;
export function registerGatewayAdminRoutes(app: FastifyInstance): void {
    const { db, cfg } = app.deps;
    const admin = { preHandler: [app.authenticate, requireAdmin] };
    app.get('/api/v1/gateway/settings', admin, async (req, reply) => {
        const s = settings(db);
        return reply.send(ok({ revision: s.revision, publicBaseUrl: s.public_base_url ?? '', baseUrl: gatewayBaseUrl(db, `${req.protocol}://${req.host}`), maxOutputTokens: s.max_output_tokens, protocols: JSON.parse(s.protocols), models: JSON.parse(s.models_json), inputPrice: s.input_price, cachedPrice: s.cached_price, outputPrice: s.output_price, currency: s.currency }));
    });
    app.put('/api/v1/gateway/settings', admin, async (req, reply) => {
        const p = settingsSchema.safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, p.error.issues[0]?.message ?? '参数错误'));
        const v = p.data;
        if (v.publicBaseUrl) {
            try {
                const u = new URL(v.publicBaseUrl);
                if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
                    throw new Error();
            }
            catch {
                return reply.code(400).send(fail(4001, 'Base URL 必须为无凭证、查询参数和片段的 HTTP(S) 地址'));
            }
        }
        db.prepare('INSERT INTO model_config_history(id,config_json,gateway_json,actor_id,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), JSON.stringify(db.prepare("SELECT * FROM model_configs WHERE id='default'").get() ?? null), JSON.stringify(settings(db)), (req as AuthedRequest).claims.sub, Date.now());
        db.prepare(`UPDATE gateway_settings SET revision=revision+1,models_json=?,public_base_url=?,max_output_tokens=?,protocols=?,input_price=?,cached_price=?,output_price=?,currency=?,updated_at=? WHERE id='default'`).run(JSON.stringify(v.models), v.publicBaseUrl || null, v.maxOutputTokens, JSON.stringify(v.protocols), v.inputPrice, v.cachedPrice, v.outputPrice, v.currency, Date.now());
        app.audit(req, 'config_change', 'gateway', { ...v });
        return reply.send(ok({ updated: true }));
    });
    app.post('/api/v1/admin/model-config/test', admin, async (req, reply) => {
        const m = resolveChatConfig(db, app.deps.cfg);
        if (!m.configured)
            return reply.code(409).send(fail(4091, '请先保存完整的模型配置'));
        const started = Date.now(),revision=settings(db).revision;
        const save=(result:{success:boolean,httpStatus?:number,latencyMs:number,message:string})=>{
            db.prepare('INSERT INTO model_connection_checks(id,revision,success,http_status,latency_ms,message,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),revision,result.success?1:0,result.httpStatus??null,result.latencyMs,result.message,Date.now());
            return {...result,revision,checkedAt:Date.now(),stale:revision!==settings(db).revision};
        };
        try {
            const res = await meteredFetch(`${m.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${m.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: m.model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply OK' }] }), signal: AbortSignal.timeout(20000) }, { source: 'connection_test', model: m.model ?? 'unknown' });
            const body = await res.json().catch(() => null) as any;
            const success = res.ok && Array.isArray(body?.choices) && body.choices.length>0 && body.choices.some((x:any)=>x.message&&typeof x.message==='object');
            app.audit(req, 'config_change', 'connection_test', { success, httpStatus: res.status });
            return reply.send(ok(save({ success, httpStatus: res.status, latencyMs: Date.now() - started, message: success ? '上游实际调用成功' : res.status===429?'上游限流或账户额度不足，请检查供应商用量与套餐':res.status===401||res.status===403?'上游凭证无效或无模型权限，请检查密钥与模型授权':'上游调用失败或返回格式不兼容' })));
        }
        catch (e) {
            return reply.send(ok(save({ success: false, latencyMs: Date.now() - started, message: '连接上游失败或超时，请检查网络和接口地址' })));
        }
    });
    app.get('/api/v1/api-keys', { preHandler: app.authenticate }, async (req, reply) => {
        const claims = (req as AuthedRequest).claims;
        const userId=claims.role==='admin'?(req.query as {userId?:string}).userId:claims.sub;
        const rows = db.prepare(`SELECT k.id,k.user_id AS userId,u.display_name AS displayName,u.username,k.device_id AS deviceId,k.name,k.prefix,k.created_at AS createdAt,k.expires_at AS expiresAt,k.revoked_at AS revokedAt,k.last_used_at AS lastUsedAt,
    CASE WHEN k.revoked_at IS NOT NULL OR k.token_version!=u.token_version OR u.status!='active' THEN 'revoked' WHEN k.expires_at<=? THEN 'expired' ELSE 'active' END AS status
    FROM api_keys k JOIN users u ON u.id=k.user_id ${userId ? 'WHERE k.user_id=?' : ''} ORDER BY k.created_at DESC LIMIT 2000`).all(Date.now(), ...(userId?[userId]:[]));
        reply.header('cache-control', 'no-store');
        return reply.send(ok({ items: rows, baseUrl: gatewayBaseUrl(db, `${req.protocol}://${req.host}`) }));
    });
    app.post('/api/v1/api-keys', { preHandler: app.authenticate }, async (req, reply) => {
        const p = keySchema.safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, '请填写密钥名称和有效期'));
        const claims = (req as AuthedRequest).claims;
        const id = p.data.userId ?? claims.sub;
        if (id !== claims.sub && claims.role !== 'admin')
            return reply.code(403).send(fail(4031, '仅能为自己创建密钥'));
        if (p.data.expiresAt && p.data.expiresAt <= Date.now())
            return reply.code(400).send(fail(4001, '有效期须晚于当前时间'));
        if (!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(id))
            return reply.code(404).send(fail(4041, '用户不存在或已禁用'));
        const issued = issueKey(db, cfg, id, p.data.name, undefined, p.data.expiresAt);
        app.audit(req, 'user_change', issued.id, { apiKeyIssued: true, userId: id });
        reply.header('cache-control', 'no-store');
        return reply.send(ok({ ...issued, baseUrl: gatewayBaseUrl(db, `${req.protocol}://${req.host}`) }));
    });
    app.post('/api/v1/api-keys/:id/revoke', { preHandler: app.authenticate }, async (req, reply) => {
        const { id } = req.params as {
            id: string;
        };
        const claims = (req as AuthedRequest).claims;
        const k = db.prepare('SELECT user_id AS userId FROM api_keys WHERE id=?').get(id) as any;
        if (!k || (claims.role !== 'admin' && k.userId !== claims.sub))
            return reply.code(404).send(fail(4041, '密钥不存在'));
        db.prepare('UPDATE api_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(Date.now(), id);
        app.audit(req, 'user_change', id, { apiKeyRevoked: true });
        return reply.send(ok({ revoked: true }));
    });
    const querySchema = z.object({ from: z.coerce.number().int().min(0).optional(), to: z.coerce.number().int().min(0).optional(), userId: z.string().optional(), departmentId: z.string().optional(), source: z.string().max(80).optional(), state: z.enum(['pending', 'complete', 'partial', 'unknown','unsettled']).optional(), model: z.string().max(200).optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(100).default(25) });
    function filters(req: any): any {
        const q = querySchema.parse(req.query ?? {});
        const c = req.claims;
        const from = q.from ?? Date.now() - 30 * 86400000;
        const to = q.to ?? Date.now() + 1;
        if (from >= to)
            throw new Error('时间范围错误');
        const clauses = ['c.started_at>=?', 'c.started_at<?'];
        const args: any[] = [from, to];
        const user = c.role === 'admin' ? q.userId : c.sub;
        for (const [col, value] of [['user_id', user], ['department_id', q.departmentId], ['source', q.source], ['accounting_state', q.state], ['model', q.model]]) {
            if(col==='accounting_state'&&value==='unsettled'){clauses.push("c.accounting_state IN ('unknown','partial')");continue;}
            if (value) {
                clauses.push(`c.${col}=?`);
                args.push(value);
            }
        }
        return { q, where: clauses.join(' AND '), args, from, to };
    }
    app.get('/api/v1/usage', { preHandler: app.authenticate }, async (req, reply) => {
        recoverStaleCalls(db);
        let f: any;
        try {
            f = filters(req);
        }
        catch {
            return reply.code(400).send(fail(4001, '筛选参数错误'));
        }
        const { where, args, q } = f;
        const summary = db.prepare(`SELECT COUNT(*) AS calls,COALESCE(SUM(total_tokens),0) AS totalTokens,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,COALESCE(SUM(cached_tokens),0) AS cachedTokens,SUM(CASE WHEN accounting_state!='complete' THEN 1 ELSE 0 END) AS unsettled,SUM(CASE WHEN outcome IN ('failed','interrupted') THEN 1 ELSE 0 END) AS failed FROM model_calls c WHERE ${where}`).get(...args);
        const costs = db.prepare(`SELECT currency,SUM(estimated_cost) AS estimatedCost,COUNT(*) AS pricedCalls FROM model_calls c WHERE ${where} AND estimated_cost IS NOT NULL GROUP BY currency`).all(...args);
        const rankings = db.prepare(`SELECT c.user_id AS userId,MAX(c.user_name) AS username,u.display_name AS displayName,COUNT(*) AS calls,COALESCE(SUM(total_tokens),0) AS totalTokens,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,SUM(CASE WHEN accounting_state!='complete' THEN 1 ELSE 0 END) AS unsettled FROM model_calls c LEFT JOIN users u ON u.id=c.user_id WHERE ${where} GROUP BY c.user_id HAVING SUM(c.total_tokens)>0 ORDER BY totalTokens DESC,calls DESC LIMIT 100`).all(...args);
        const departments = db.prepare(`SELECT COALESCE(c.department_name,'未分配') AS name,COUNT(*) AS calls,COALESCE(SUM(total_tokens),0) AS totalTokens FROM model_calls c WHERE ${where} GROUP BY c.department_id,c.department_name ORDER BY totalTokens DESC`).all(...args);
        const sources = db.prepare(`SELECT source,model,COUNT(*) AS calls,COALESCE(SUM(total_tokens),0) AS totalTokens FROM model_calls c WHERE ${where} GROUP BY source,model ORDER BY totalTokens DESC`).all(...args);
        const trend = db.prepare(`SELECT strftime('%Y-%m-%d',started_at/1000,'unixepoch','+8 hours') AS day,COUNT(*) AS calls,COALESCE(SUM(total_tokens IS NOT NULL),0) AS knownCalls,COALESCE(SUM(accounting_state IN ('unknown','partial')),0) AS unsettled,COALESCE(SUM(total_tokens),0) AS totalTokens FROM model_calls c WHERE ${where} GROUP BY day ORDER BY day`).all(...args);
        const items = db.prepare(`SELECT ${selectCall} FROM model_calls c LEFT JOIN users u ON u.id=c.user_id WHERE ${where} ORDER BY c.started_at DESC,c.id LIMIT ? OFFSET ?`).all(...args, q.size, (q.page - 1) * q.size);
        const coverage=db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(accounting_state='complete'),0) AS complete,COALESCE(SUM(total_tokens IS NOT NULL),0) AS known FROM model_calls c WHERE ${where}`).get(...args);
        const collectionStartedAt=Number((db.prepare("SELECT value FROM product_metadata WHERE key='usage_collection_started_at'").get() as any).value);
        return reply.send(ok({ coverage,collectionStartedAt,summary, costs, rankings, departments, sources, trend, items, page: q.page, size: q.size, from: f.from, to: f.to, updatedAt: Date.now() }));
    });
    app.get('/api/v1/usage/export', { preHandler: app.authenticate }, async (req, reply) => {
        let f: any;
        try {
            f = filters(req);
        }
        catch {
            return reply.code(400).send(fail(4001, '筛选参数错误'));
        }
        const rows = db.prepare(`SELECT ${selectCall} FROM model_calls c LEFT JOIN users u ON u.id=c.user_id WHERE ${f.where} ORDER BY c.started_at DESC LIMIT 10000`).all(...f.args) as any[];
        const cols = ['id', 'username', 'departmentName', 'source', 'model', 'startedAt', 'accountingState', 'inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens', 'estimatedCost', 'currency'];
        const cell = (x: any) => '"' + String(x ?? '').replace(/^([\s]*[=+@\-])/, "'$1").replace(/"/g, '""') + '"';
        app.audit(req, 'usage_export', undefined, { count: rows.length, from: f.from, to: f.to });
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="echo-usage.csv"').send('\uFEFF' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n'));
    });
    app.post('/api/v1/admin/usage/:id/reconcile', admin, async (req, reply) => {
        const p = z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), cachedTokens: z.number().int().min(0).default(0),actualCost:z.number().min(0).optional(),currency:z.enum(['CNY','USD']).optional(), note: z.string().trim().min(3).max(1000) }).safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, '请填写实际用量和核对依据'));
        const { id } = req.params as {
            id: string;
        };
        const row = db.prepare('SELECT * FROM model_calls WHERE id=?').get(id) as any;
        if (!row)
            return reply.code(404).send(fail(4041, '调用不存在'));
        if (row.outcome === 'running' && row.started_at > Date.now() - 180000)
            return reply.code(409).send(fail(4091, '调用仍在执行'));
        if (row.accounting_state === 'complete' && (row.estimated_cost!==null || p.data.actualCost===undefined))
            return reply.code(409).send(fail(4091, '调用已结算'));
        const v = p.data;
        if(row.accounting_state==='complete'&&(v.inputTokens!==row.input_tokens||v.outputTokens!==row.output_tokens||v.cachedTokens!==(row.cached_tokens??0)))return reply.code(400).send(fail(4001,'已结算 Token 不可在费用核对中更改'));
        if(v.actualCost===undefined&&v.currency&&v.currency!==row.currency)return reply.code(400).send(fail(4001,'估算费用不能直接切换币种，请填写核对金额'));
        if (v.cachedTokens > v.inputTokens)
            return reply.code(400).send(fail(4001, '缓存 Token 不能大于输入 Token'));
        const price = JSON.parse(row.price_json ?? '{}');
        const cost = v.actualCost ?? (!row.cache_write_tokens && price.input !== null && price.output !== null && (v.cachedTokens === 0 || price.cached !== null) ? ((v.inputTokens - v.cachedTokens) * price.input + v.cachedTokens * (price.cached ?? price.input) + v.outputTokens * price.output) / 1e6 : null);
        db.prepare(`UPDATE model_calls SET input_tokens=?,output_tokens=?,cached_tokens=?,total_tokens=?,reserved_tokens=0,reserved_cost=0,accounting_state='complete',outcome=CASE WHEN outcome='running' THEN 'interrupted' ELSE outcome END,finished_at=COALESCE(finished_at,?),estimated_cost=?,currency=?,cost_source=?,reconciled_by=?,reconciled_at=? WHERE id=?`).run(v.inputTokens, v.outputTokens, v.cachedTokens, v.inputTokens + v.outputTokens, Date.now(), cost,v.currency??row.currency,v.actualCost!==undefined?'reconciled':'estimated', (req as AuthedRequest).claims.sub, Date.now(), id);
        app.audit(req, 'usage_reconcile', id, { ...v });
        return reply.send(ok({ updated: true }));
    });
    app.get('/api/v1/quotas', { preHandler: app.authenticate }, async (req, reply) => {
        const claims = (req as AuthedRequest).claims;
        const department = (db.prepare('SELECT department_id AS id FROM users WHERE id=?').get(claims.sub) as any)?.id;
        const rules = db.prepare(`SELECT * FROM quota_rules ${claims.role === 'admin' ? '' : "WHERE target_type='org' OR (target_type='user' AND target_id=?) OR (target_type='department' AND target_id=?) OR (target_type='key' AND target_id IN (SELECT id FROM api_keys WHERE user_id=?))"} ORDER BY updated_at DESC`).all(...(claims.role === 'admin' ? [] : [claims.sub, department ?? '', claims.sub])) as any[];
        return reply.send(ok(rules.map(r => ({ ...r, usage: quotaUsage(db, r) }))));
    });
    app.put('/api/v1/quotas/:id', admin, async (req, reply) => {
        const p = quotaSchema.safeParse(req.body);
        if (!p.success)
            return reply.code(400).send(fail(4001, '配额参数错误'));
        const v = p.data;
        const id = (req.params as {
            id: string;
        }).id === 'new' ? randomUUID() : (req.params as {
            id: string;
        }).id;
        const table = { department: 'groups', user: 'users', key: 'api_keys', org: null }[v.targetType];
        if (table && !db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(v.targetId))
            return reply.code(400).send(fail(4001, '配额对象不存在'));
        try {
            db.prepare(`INSERT INTO quota_rules(id,target_type,target_id,window,window_hours,token_limit,cost_limit,currency,rpm,concurrency,action,enabled,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET target_type=excluded.target_type,target_id=excluded.target_id,window=excluded.window,window_hours=excluded.window_hours,token_limit=excluded.token_limit,cost_limit=excluded.cost_limit,currency=excluded.currency,rpm=excluded.rpm,concurrency=excluded.concurrency,action=excluded.action,enabled=excluded.enabled,updated_at=excluded.updated_at`).run(id, v.targetType, v.targetType === 'org' ? 'all' : v.targetId, v.window, v.windowHours, v.tokenLimit, v.costLimit, v.currency, v.rpm, v.concurrency, v.action, Number(v.enabled), Date.now());
        }
        catch (e) {
            if (String(e).includes('UNIQUE'))
                return reply.code(409).send(fail(4091, '同一对象和周期已有规则，请编辑原规则'));
            throw e;
        }
        app.audit(req, 'config_change', id, { quota: v });
        return reply.send(ok({ id }));
    });
    app.delete('/api/v1/quotas/:id', admin, async (req, reply) => {
        const { id } = req.params as {
            id: string;
        };
        db.prepare('DELETE FROM quota_rules WHERE id=?').run(id);
        app.audit(req, 'config_change', id, { quotaDeleted: true });
        return reply.send(ok({ deleted: true }));
    });
}
