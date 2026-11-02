import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { testConfig } from '../src/config.js';
import { createUser, changePassword } from '../src/dao/users.js';
import { ensureOrgScope } from '../src/server.js';
import { UsageObserver, usageContext } from '../src/gateway/usage.js';
import { callStructuredChat } from '../src/models/structured-chat.js';
import { z } from 'zod';
let db: DB, app: FastifyInstance, admin: string, alice: string, bob: string, aliceId: string, bobId: string;
const bearer = (s: string) => ({ authorization: `Bearer ${s}` });
const completion = (input = 100, output = 40) => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } } });
const respond = (j: unknown) => new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } });
async function login(username: string) { const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'test-password', deviceId: `device-${username}` } }); expect(r.statusCode).toBe(200); return r.json().data.accessToken as string; }
async function key(token: string) { const r = await app.inject({ url: '/api/v1/client/model-config', headers: bearer(token) }); expect(r.statusCode).toBe(200); return r.json().data; }
async function chat(token: string, extra = {}) { return app.inject({ method: 'POST', url: '/api/v1/llm/v1/chat/completions', headers: bearer(token), payload: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 20, ...extra } }); }
beforeEach(async () => {
    db = openDb({ path: ':memory:' });
    ensureOrgScope(db);
    await createUser(db, { username: 'admin', password: 'test-password', role: 'admin', clearance: 2 });
    aliceId = (await createUser(db, { username: 'alice', password: 'test-password' })).id;
    bobId = (await createUser(db, { username: 'bob', password: 'test-password' })).id;
    app = buildApp({ db, cfg: testConfig({ chatModel: 'approved', chatKey: 'UPSTREAM-ONLY', chatBaseUrl: 'https://upstream.invalid/v1' }), serveWeb: false });
    admin = await login('admin');
    alice = await login('alice');
    bob = await login('bob');
    vi.stubGlobal('fetch', vi.fn(async () => respond(completion())));
});
afterEach(async () => { vi.unstubAllGlobals(); await app.close(); db.close(); });
describe('user gateway lifecycle and accounting', () => {
    it('distributes stable per-device keys, server Base URL, and never the upstream key', async () => {
        const a = await key(alice), again = await key(alice), b = await key(bob);
        expect(a.chatKey).toMatch(/^[0-9A-F]{32}$/);
        expect(a.chatKey).toBe(again.chatKey);
        expect(a.chatKey).not.toBe(b.chatKey);
        expect(a.chatBaseUrl).toMatch(/\/api\/v1\/llm\/v1$/);
        expect(JSON.stringify(a)).not.toContain('UPSTREAM-ONLY');
        expect((await app.inject({ url: '/api/v1/admin/users', headers: bearer(a.chatKey) })).statusCode).toBe(401);
    });
    it('passes the upstream key only upstream, forces allowed model/output cap, and records actual cache-aware totals', async () => {
        const a = await key(alice);
        const res = await chat(a.chatKey, { model: 'unapproved', max_tokens: 999999 });
        expect(res.statusCode).toBe(200);
        const call = (fetch as any).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.model).toBe('approved');
        expect(body.max_tokens).toBe(8192);
        expect(call[1].headers.authorization).toBe('Bearer UPSTREAM-ONLY');
        const row = db.prepare('SELECT * FROM model_calls').get() as any;
        expect(row).toMatchObject({ user_id: aliceId, key_id: a.credentialId, input_tokens: 100, output_tokens: 40, cached_tokens: 20, reasoning_tokens: 5, total_tokens: 140, accounting_state: 'complete', reserved_tokens: 0 });
    });
    it('keeps missing usage unknown, reserves it, and supports audited reconciliation once', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => respond({ choices: [] })));
        await chat((await key(alice)).chatKey);
        const row = db.prepare('SELECT * FROM model_calls').get() as any;
        expect(row.accounting_state).toBe('unknown');
        expect(row.total_tokens).toBeNull();
        expect(row.reserved_tokens).toBeGreaterThan(0);
        const request = { method: 'POST' as const, url: `/api/v1/admin/usage/${row.id}/reconcile`, headers: bearer(admin), payload: { inputTokens: 8, outputTokens: 2, note: '上游账单核对' } };
        expect((await app.inject(request)).statusCode).toBe(200);
        expect((db.prepare('SELECT total_tokens,reserved_tokens FROM model_calls WHERE id=?').get(row.id))).toEqual({ total_tokens: 10, reserved_tokens: 0 });
        expect((await app.inject(request)).statusCode).toBe(409);
        expect((await app.inject({ ...request, headers: bearer(alice) })).statusCode).toBe(403);
    });
    it('revokes on explicit revoke, password reset, account disable and rotates without losing totals', async () => {
        const a = await key(alice);
        await chat(a.chatKey);
        expect((await app.inject({ method: 'POST', url: `/api/v1/api-keys/${a.credentialId}/revoke`, headers: bearer(alice) })).statusCode).toBe(200);
        expect((await chat(a.chatKey)).statusCode).toBe(401);
        const rotated = await key(alice);
        expect(rotated.chatKey).not.toBe(a.chatKey);
        await changePassword(db, aliceId, 'new-password');
        expect((await chat(rotated.chatKey)).statusCode).toBe(401);
        const b = await key(bob);
        db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(bobId);
        expect((await chat(b.chatKey)).statusCode).toBe(401);
        expect((db.prepare('SELECT COUNT(*) AS n FROM model_calls').get() as any).n).toBe(1);
    });
    it('accounts JWT legacy proxy and internal structured calls with the same authenticated user', async () => {
        await chat(alice);
        await usageContext.run({ db, cfg: app.deps.cfg, userId: aliceId, taskId: 'internal-test' }, () => callStructuredChat(db, app.deps.cfg, { schema: z.object({ ok: z.boolean() }), system: 'test', user: 'test' }));
        const rows = db.prepare('SELECT user_id,source,total_tokens FROM model_calls ORDER BY started_at').all() as any[];
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.user_id === aliceId && r.total_tokens === 140)).toBe(true);
        expect(rows[1].source).toBe('knowledge_reasoning');
    });
    it('isolates usage and exports by live user, keeps historical department attribution', async () => {
        db.prepare("INSERT INTO groups(id,name,created_at) VALUES('d','研发',0)").run();
        db.prepare("UPDATE users SET department_id='d' WHERE id=?").run(aliceId);
        await chat((await key(alice)).chatKey);
        await chat((await key(bob)).chatKey);
        db.prepare('UPDATE users SET department_id=NULL WHERE id=?').run(aliceId);
        const mine = (await app.inject({ url: `/api/v1/usage?userId=${bobId}`, headers: bearer(alice) })).json().data;
        expect(mine.summary.calls).toBe(1);
        expect(mine.rankings[0].userId).toBe(aliceId);
        expect(mine.items[0].departmentName).toBe('研发');
        const all = (await app.inject({ url: '/api/v1/usage', headers: bearer(admin) })).json().data;
        expect(all.summary.calls).toBe(2);
        const csv = await app.inject({ url: '/api/v1/usage/export', headers: bearer(alice) });
        expect(csv.body).toContain('alice');
        expect(csv.body).not.toContain('bob');
    });
    it('computes costs using the call-time price version and never doubles cached/reasoning tokens', async () => {
        db.prepare("UPDATE gateway_settings SET input_price=2,cached_price=1,output_price=4 WHERE id='default'").run();
        await chat((await key(alice)).chatKey);
        db.prepare("UPDATE gateway_settings SET input_price=99,revision=revision+1 WHERE id='default'").run();
        const row = db.prepare('SELECT estimated_cost,total_tokens,price_revision FROM model_calls').get() as any;
        expect(row.estimated_cost).toBeCloseTo((80 * 2 + 20 + 40 * 4) / 1e6);
        expect(row.total_tokens).toBe(140);
        expect(row.price_revision).toBe(1);
    });
    it('blocks unpriced cost budgets until an administrator reconciles the cost without changing settled tokens',async()=>{
        const a=await key(alice);await chat(a.chatKey)
        const row=db.prepare('SELECT id FROM model_calls').get() as any
        db.prepare("UPDATE gateway_settings SET input_price=2,cached_price=1,output_price=4").run()
        db.prepare("INSERT INTO quota_rules(id,target_type,target_id,window,cost_limit,currency,updated_at) VALUES('cost','user',?,'month',100,'CNY',0)").run(aliceId)
        expect((await chat(a.chatKey)).statusCode).toBe(429)
        const req={method:'POST' as const,url:`/api/v1/admin/usage/${row.id}/reconcile`,headers:bearer(admin)}
        expect((await app.inject({...req,payload:{inputTokens:0,outputTokens:0,actualCost:.02,note:'bill verified'}})).statusCode).toBe(400)
        expect((await app.inject({...req,payload:{inputTokens:100,outputTokens:40,cachedTokens:20,actualCost:.02,currency:'CNY',note:'bill verified'}})).statusCode).toBe(200)
        expect((await chat(a.chatKey)).statusCode).toBe(200)
    });
    it('atomically reserves across concurrent calls and treats zero as blocked, null as unlimited', async () => {
        const a = await key(alice);
        db.prepare("INSERT INTO quota_rules(id,target_type,target_id,window,concurrency,updated_at) VALUES('r','user',?,'month',1,0)").run(aliceId);
        let release: () => void = () => { };
        let started: () => void = () => { };
        const begun = new Promise<void>(r => { started = r; }), wait = new Promise<void>(r => { release = r; });
        vi.stubGlobal('fetch', vi.fn(async () => { started(); await wait; return respond(completion()); }));
        const first = chat(a.chatKey);
        const promise = first.then(r => r);
        await begun;
        const second = await chat(a.chatKey);
        expect(second.statusCode).toBe(429);
        release();
        expect((await promise).statusCode).toBe(200);
        db.prepare("UPDATE quota_rules SET concurrency=NULL,token_limit=0 WHERE id='r'").run();
        expect((await chat(a.chatKey)).statusCode).toBe(429);
        db.prepare("UPDATE quota_rules SET token_limit=NULL WHERE id='r'").run();
        expect((await chat(a.chatKey)).statusCode).toBe(200);
    });
    it('requests final SSE usage, preserves stream bytes, and settles cumulative usage only once', async () => {
        const stream = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\r\n\r\ndata: ' + JSON.stringify({ choices: [], usage: completion().usage }) + '\r\n\r\ndata: [DONE]\r\n\r\n';
        vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));
        const res = await chat((await key(alice)).chatKey, { stream: true });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(stream);
        expect(JSON.parse((fetch as any).mock.calls[0][1].body).stream_options.include_usage).toBe(true);
        expect(db.prepare('SELECT total_tokens,accounting_state FROM model_calls').get()).toEqual({ total_tokens: 140, accounting_state: 'complete' });
    });
    it('keeps interrupted stream with no final usage unresolved', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })));
        await chat((await key(alice)).chatKey, { stream: true });
        expect(db.prepare('SELECT total_tokens,accounting_state FROM model_calls').get()).toEqual({ total_tokens: null, accounting_state: 'unknown' });
    });
    it('only enables compatible protocols explicitly and accounts Responses/Anthropic independently', async () => {
        const a = await key(alice);
        expect((await app.inject({ method: 'POST', url: '/api/v1/llm/v1/responses', headers: bearer(a.chatKey), payload: { input: 'hi' } })).statusCode).toBe(403);
        db.prepare(`UPDATE gateway_settings SET protocols='["chat","responses","anthropic"]'`).run();
        vi.stubGlobal('fetch', vi.fn(async () => respond({ type: 'response.completed', response: { usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 } } })));
        expect((await app.inject({ method: 'POST', url: '/api/v1/llm/v1/responses', headers: bearer(a.chatKey), payload: { input: 'hi' } })).statusCode).toBe(200);
        expect((db.prepare('SELECT total_tokens FROM model_calls').get() as any).total_tokens).toBe(100);
    });
});
describe('protocol usage normalization', () => {
    it('handles arbitrary UTF8/event splits, repeated usage, cache subsets and terminal events', () => {
        const o = new UsageObserver(true), bytes = new TextEncoder().encode('data: ' + JSON.stringify({ usage: completion().usage }) + '\r\n\r\ndata: ' + JSON.stringify({ usage: completion().usage }) + '\r\n\r\ndata: [DONE]\r\n\r\n');
        for (let i = 0; i < bytes.length; i++)
            o.push(bytes.slice(i, i + 1));
        o.end();
        expect(o.usage).toMatchObject({ input: 100, output: 40, cached: 20, reasoning: 5, total: 140 });
        expect(o.terminal).toBe(true);
    });
    it('adds Anthropic uncached input and cache fields, not the same cached subset twice', () => {
        const o = new UsageObserver();
        o.observe({ type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 0 } } });
        o.observe({ type: 'message_delta', usage: { output_tokens: 8 } });
        expect(o.usage).toMatchObject({ input: 35, output: 8, total: 43, cached: 20 });
    });
});
