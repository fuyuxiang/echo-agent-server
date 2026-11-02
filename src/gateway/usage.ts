import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { Config } from '../config.js';
export interface UsageContext {
    db: DB;
    cfg: Config;
    userId?: string;
    keyId?: string;
    deviceId?: string;
    taskId?: string;
    assetId?: string;
    source?: string;
}
export const usageContext = new AsyncLocalStorage<UsageContext>();
export interface Usage {
    input: number | null;
    output: number | null;
    cached: number;
    cacheWrite?: number;
    reasoning: number;
    total: number | null;
}
const num = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' ? v as Record<string, any> : {};
/** Vendor totals are cumulative snapshots. Cached/reasoning tokens are subsets. */
export class UsageObserver {
    usage: Usage = { input: null, output: null, cached: 0, reasoning: 0, total: null };
    terminal = false;
    private decoder = new TextDecoder();
    private buffer = '';
    private json = '';
    constructor(private sse = false) { }
    observe(value: unknown): void {
        const j = object(value);
        if (j.type === 'message_stop' || j.type === 'response.completed')
            this.terminal = true;
        const u = object(j.usage ?? object(j.response).usage ?? object(j.message).usage);
        const anthropic = u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined || j.type?.startsWith('message_');
        let input = num(u.prompt_tokens ?? u.input_tokens);
        const cached = num(object(u.prompt_tokens_details ?? u.input_tokens_details).cached_tokens) ?? num(u.cache_read_input_tokens) ?? 0;
        if (input !== null && anthropic)
            input += cached + (num(u.cache_creation_input_tokens) ?? 0);
        const output = num(u.completion_tokens ?? u.output_tokens);
        const total = num(u.total_tokens);
        const cacheWrite = num(u.cache_creation_input_tokens) ?? 0;
        this.usage.cacheWrite = Math.max(this.usage.cacheWrite ?? 0, cacheWrite);
        const reasoning = num(object(u.completion_tokens_details ?? u.output_tokens_details).reasoning_tokens) ?? 0;
        const max = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
        this.usage.input = max(this.usage.input, input);
        this.usage.output = max(this.usage.output, output);
        this.usage.cached = Math.max(this.usage.cached, cached);
        this.usage.reasoning = Math.max(this.usage.reasoning, reasoning);
        this.usage.total = max(this.usage.total, total);
        if (this.usage.input !== null || this.usage.output !== null)
            this.usage.total = Math.max(this.usage.total ?? 0, (this.usage.input ?? 0) + (this.usage.output ?? 0));
        if (Array.isArray(j.choices) && j.choices.some((c: any) => c.finish_reason))
            this.terminal = true;
    }
    push(bytes: Uint8Array): void {
        const value = this.decoder.decode(bytes, { stream: true });
        if (!this.sse) {
            if (this.json.length < 4000000)
                this.json += value;
            return;
        }
        this.buffer += value;
        // Normalize CRLF after concatenation so a split CR/LF stays intact.
        this.buffer = this.buffer.replace(/\r\n/g, '\n');
        let end: number;
        while ((end = this.buffer.indexOf('\n\n')) >= 0) {
            const event = this.buffer.slice(0, end);
            this.buffer = this.buffer.slice(end + 2);
            this.event(event);
        }
        if (this.buffer.length > 512000)
            this.buffer = ''; // malformed events never grow without bound
    }
    private event(event: string): void {
        const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') {
            this.terminal = true;
            return;
        }
        if (data) {
            try {
                this.observe(JSON.parse(data));
            }
            catch { /* non-JSON events carry no usage */ }
        }
    }
    end(): void {
        const tail = this.decoder.decode();
        if (this.sse) {
            this.buffer += tail;
            if (this.buffer.trim())
                this.event(this.buffer.replace(/\r\n/g, '\n'));
        }
        else {
            try {
                this.observe(JSON.parse(this.json + tail));
            }
            catch { /* binary/unknown usage remains unknown */ }
        }
    }
}
export class QuotaError extends Error {
    statusCode = 429;
    code = 'quota_exceeded';
}
export function windowStart(window: string, hours: number, now = Date.now()): number {
    // Consistent Asia/Shanghai calendar, independent of process/server timezone.
    if (window === 'rolling')
        return now - hours * 3600000;
    const d = new Date(now + 8 * 3600000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), window === 'month' ? 1 : d.getUTCDate()) - 8 * 3600000;
}
export function recoverStaleCalls(db: DB): void { db.prepare("UPDATE model_calls SET outcome='interrupted',accounting_state=CASE WHEN total_tokens IS NULL THEN 'unknown' ELSE 'partial' END,finished_at=?,error_code='process_interrupted' WHERE outcome='running' AND started_at<?").run(Date.now(), Date.now() - 300000); }
export function settings(db: DB): any { return db.prepare("SELECT * FROM gateway_settings WHERE id='default'").get(); }
export function quotaUsage(db: DB, rule: any, now = Date.now()): any {
    const col = { org: null, department: 'department_id', user: 'user_id', key: 'key_id' }[rule.target_type as 'org' | 'department' | 'user' | 'key'];
    const where = col ? ` AND ${col}=?` : '';
    const args = col ? [rule.target_id] : [];
    const since = windowStart(rule.window, rule.window_hours, now);
    const total = db.prepare(`SELECT COALESCE(SUM(MAX(COALESCE(total_tokens,0),reserved_tokens)),0) AS tokens,
    COALESCE(SUM(CASE WHEN currency=? THEN MAX(COALESCE(estimated_cost,0),COALESCE(reserved_cost,0)) ELSE 0 END),0) AS cost,
    SUM(CASE WHEN estimated_cost IS NULL AND (accounting_state='complete' OR reserved_cost IS NULL) AND currency=? AND outcome!='rejected' THEN 1 ELSE 0 END) AS unpriced
    FROM model_calls WHERE started_at>=?${where}`).get(rule.currency, rule.currency,since, ...args) as any;
    const live = db.prepare(`SELECT SUM(CASE WHEN started_at>=? THEN 1 ELSE 0 END) AS rpm,
    SUM(CASE WHEN outcome='running' AND started_at>=? THEN 1 ELSE 0 END) AS concurrent
    FROM model_calls WHERE started_at>=?${where}`).get(now - 60000, now - 180000, now - 180000, ...args) as any;
    return { ...total, rpm: live.rpm ?? 0, concurrent: live.concurrent ?? 0, since };
}
interface Meta {
    source: string;
    model?: string;
    protocol?: string;
    estimatedTokens?: number;
    units?: Record<string, number | string>;
}
export function beginCall(ctx: UsageContext, meta: Meta, reserved: number): string {
    const { db } = ctx;
    recoverStaleCalls(db);
    const now = Date.now();
    const id = randomUUID();
    const user = ctx.userId ? db.prepare(`SELECT u.username,u.department_id AS dept,g.name AS deptName FROM users u LEFT JOIN groups g ON g.id=u.department_id WHERE u.id=?`).get(ctx.userId) as any : undefined;
    const s = settings(db);
    const configured = db.prepare("SELECT chat_model AS model FROM model_configs WHERE id='default'").get() as {
        model: string;
    } | undefined;
    const priced = meta.model === (configured?.model ?? ctx.cfg.chatModel);
    const price = priced ? { input: s.input_price, cached: s.cached_price, output: s.output_price } : { input: null, cached: null, output: null };
    const reservedCost = price.input !== null && price.output !== null ? reserved * Math.max(price.input, price.output, price.cached ?? 0) / 1e6 : null;
    db.transaction(() => {
        if (ctx.userId && ctx.cfg.rateLimitLlmPerMin > 0) {
            const n = (db.prepare('SELECT COUNT(*) AS n FROM model_calls WHERE user_id=? AND started_at>=?').get(ctx.userId, now - 60000) as any).n;
            if (n >= ctx.cfg.rateLimitLlmPerMin)
                throw new QuotaError('当前用户请求过于频繁，请稍后重试');
        }
        const rules = db.prepare(`SELECT * FROM quota_rules WHERE enabled=1 AND (target_type='org' OR (target_type='user' AND target_id=?) OR (target_type='department' AND target_id=?) OR (target_type='key' AND target_id=?))`).all(ctx.userId ?? '', user?.dept ?? '', ctx.keyId ?? '') as any[];
        for (const r of rules) {
            const u = quotaUsage(db, r, now);
            const exceeded = (r.token_limit !== null && (r.token_limit === 0 || u.tokens + reserved > r.token_limit)) || (r.cost_limit !== null && (r.cost_limit === 0 || (u.unpriced??0)>0 || reservedCost === null || r.currency !== s.currency || u.cost + reservedCost > r.cost_limit)) || (r.rpm !== null && u.rpm >= r.rpm) || (r.concurrency !== null && u.concurrent >= r.concurrency);
            if (exceeded && r.action === 'block')
                throw new QuotaError('已达到模型用量或并发限额，请查看配额与待核对调用');
        }
        db.prepare(`INSERT INTO model_calls(id,user_id,user_name,department_id,department_name,key_id,device_id,task_id,asset_id,source,model,protocol,started_at,reserved_tokens,currency,price_revision,price_json,units_json,reserved_cost)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, ctx.userId ?? null, user?.username ?? null, user?.dept ?? null, user?.deptName ?? null, ctx.keyId ?? null, ctx.deviceId ?? null, ctx.taskId ?? null, ctx.assetId ?? null, ctx.source === 'document_ingest' ? 'document_ingest' : meta.source, meta.model ?? 'unknown', meta.protocol ?? 'openai', now, reserved, s.currency, s.revision, JSON.stringify(price), meta.units ? JSON.stringify(meta.units) : null, reservedCost);
    })();
    return id;
}
export function settleCall(db: DB, id: string, usage: Usage, status: number | null, outcome: string, complete: boolean, error?: string): void {
    const row = db.prepare('SELECT price_json AS price,currency FROM model_calls WHERE id=? AND finished_at IS NULL').get(id) as any;
    if (!row)
        return;
    const known = usage.total !== null;
    const state = known ? (complete && usage.input !== null && usage.output !== null && usage.cached<=usage.input && (usage.cacheWrite??0)<=usage.input && usage.reasoning<=usage.output ? 'complete' : 'partial') : 'unknown';
    const p = JSON.parse(row.price ?? '{}');
    const cost = state === 'complete' && !(usage.cacheWrite ?? 0) && p.input !== null && p.output !== null && (usage.cached === 0 || p.cached !== null)
        ? ((Math.max(0, (usage.input ?? 0) - usage.cached) * p.input) + (usage.cached * (p.cached ?? p.input)) + (usage.output ?? 0) * p.output) / 1000000 : null;
    db.prepare(`UPDATE model_calls SET finished_at=?,http_status=?,outcome=?,accounting_state=?,input_tokens=?,output_tokens=?,cached_tokens=?,cache_write_tokens=?,reasoning_tokens=?,total_tokens=?,reserved_tokens=CASE WHEN ?='complete' THEN 0 ELSE reserved_tokens END,reserved_cost=CASE WHEN ?='complete' THEN 0 ELSE reserved_cost END,estimated_cost=?,error_code=? WHERE id=? AND finished_at IS NULL`).run(Date.now(), status, outcome, state, usage.input, usage.output, usage.cached, usage.cacheWrite ?? 0, usage.reasoning, usage.total, state, state, cost, error ?? null, id);
}
/** Observe the actual upstream attempt; retries create separate ledger entries. No prompts or responses are persisted. */
export async function meteredFetch(input: string | URL | Request, init: RequestInit | undefined, meta: Meta): Promise<Response> {
    const ctx = usageContext.getStore();
    if (!ctx)
        return fetch(input, init);
    let body: any = {};
    if (typeof init?.body === 'string') {
        try {
            body = JSON.parse(init.body);
        }
        catch { }
    }
    const reserve = meta.estimatedTokens ?? (Buffer.byteLength(typeof init?.body === 'string' ? init.body : '') + Number(body.max_completion_tokens ?? body.max_tokens ?? settings(ctx.db).max_output_tokens));
    const id = beginCall(ctx, { ...meta, model: meta.model ?? body.model }, reserve);
    const empty: Usage = { input: null, output: null, cached: 0, reasoning: 0, total: null };
    let response: Response;
    try {
        response = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
    }
    catch (e) {
        settleCall(ctx.db, id, empty, null, 'failed', false, e instanceof Error ? e.name : 'network');
        throw e;
    }
    const isSse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    const observer = new UsageObserver(isSse);
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    if (requestId)
        ctx.db.prepare('UPDATE model_calls SET upstream_request_id=? WHERE id=?').run(requestId, id);
    if (!response.body) {
        settleCall(ctx.db, id, empty, response.status, response.ok ? 'succeeded' : 'failed', true);
        return response;
    }
    const reader = response.body.getReader();
    let settled = false;
    const finish = (complete: boolean, error?: string) => { if (settled)
        return; settled = true; observer.end(); if (meta.source === 'embedding' && observer.usage.input !== null && observer.usage.output === null)
        observer.usage.output = 0; settleCall(ctx.db, id, observer.usage, response.status, response.ok ? (complete ? 'succeeded' : 'interrupted') : 'failed', complete && (!isSse || observer.terminal), error); };
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) { try {
            const { done, value } = await reader.read();
            if (done) {
                finish(true);
                controller.close();
            }
            else {
                observer.push(value);
                controller.enqueue(value);
            }
        }
        catch (e) {
            finish(false, 'stream_error');
            controller.error(e);
        } },
        async cancel(reason) { finish(false, 'cancelled'); await reader.cancel(reason); }
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
