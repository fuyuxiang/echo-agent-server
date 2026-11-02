import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { testConfig } from '../src/config.js';
import { createUser } from '../src/dao/users.js';
import { ensureOrgScope } from '../src/server.js';
import { createFullBackup, restoreFullBackup } from '../src/operations/backup.js';
import { createDocumentFamily } from '../src/dao/documents.js';
let db: DB, app: FastifyInstance, admin: string, alice: string, adminId: string, aliceId: string, temp: string;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function login(name: string) { return (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: name, password: 'test-password', deviceId: `device-${name}` } })).json().data.accessToken as string; }
beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'echo-ops-test-'));
    db = openDb({ path: ':memory:' });
    ensureOrgScope(db);
    adminId = (await createUser(db, { username: 'admin', password: 'test-password', role: 'admin', clearance: 2 })).id;
    aliceId = (await createUser(db, { username: 'alice', password: 'test-password' })).id;
    app = buildApp({ db, cfg: testConfig({ storageDir: join(temp, 'storage') }), serveWeb: false });
    admin = await login('admin');
    alice = await login('alice');
});
afterEach(async () => { await app.close(); db.close(); await rm(temp, { recursive: true, force: true }); });
const org = () => (db.prepare("SELECT id FROM scopes WHERE kind='org'").get() as any).id as string;
function memory(id: string, scope: string, sensitivity = 0) { db.prepare("INSERT INTO org_memories(id,scope_id,kind,content,author_id,confidence,sensitivity,status,created_at,updated_at) VALUES(?,?,'fact',?, ?,0.8,?,'active',1,1)").run(id, scope, `经验 ${id}`, aliceId, sensitivity); }
describe('knowledge operations and product boundaries', () => {
    it('does not expose personal scopes, memories or conflicts to an administrator', async () => {
        const personal = `personal-${aliceId}`;
        memory('private', personal);
        memory('shared', org());
        db.prepare("INSERT INTO memory_conflicts(id,a_id,b_id,reason,created_at) VALUES('c','shared','private','test',1)").run();
        const scopes = (await app.inject({ url: '/api/v1/scopes', headers: bearer(admin) })).json().data;
        expect(scopes.some((s: any) => s.id === personal)).toBe(false);
        const memories = (await app.inject({ url: '/api/v1/memories?page=1', headers: bearer(admin) })).json().data;
        expect(memories.total).toBe(1);
        expect((await app.inject({ url: '/api/v1/memories/conflicts', headers: bearer(admin) })).json().data).toEqual([]);
        expect((await app.inject({ method: 'PATCH', url: '/api/v1/memories/private', headers: bearer(admin), payload: { content: 'change' } })).statusCode).toBe(403);
        expect((await app.inject({ url: '/api/v1/memories/private/versions', headers: bearer(admin) })).statusCode).toBe(404);
    });
    it('enforces clearance on conflicts and merges without reducing sensitivity', async () => {
        memory('a', org(), 2);
        memory('b', org(), 1);
        db.prepare("INSERT INTO memory_conflicts(id,a_id,b_id,reason,created_at) VALUES('c','a','b','test',1)").run();
        db.prepare("UPDATE users SET role='curator' WHERE id=?").run(aliceId);
        const c = await login('alice');
        expect((await app.inject({ url: '/api/v1/memories/conflicts', headers: bearer(c) })).json().data).toHaveLength(0);
        expect((await app.inject({ method: 'POST', url: '/api/v1/memories/conflicts/c/resolve', headers: bearer(c), payload: { resolution: 'keep_a', note: 'test' } })).statusCode).toBe(403);
        const res = await app.inject({ method: 'POST', url: '/api/v1/memories/conflicts/c/resolve', headers: bearer(admin), payload: { resolution: 'merge', mergedContent: '合并的经验', note: '已核对' } });
        expect(res.statusCode).toBe(200);
        const id = res.json().data.resultId;
        expect((db.prepare('SELECT sensitivity FROM org_memories WHERE id=?').get(id) as any).sensitivity).toBe(2);
    });
    it('paginates memories, records old versions and rejects stale edits', async () => {
        for (let i = 0; i < 23; i++)
            memory(`m${i}`, org());
        const page = (await app.inject({ url: '/api/v1/memories?page=2&size=20', headers: bearer(admin) })).json().data;
        expect(page.total).toBe(23);
        expect(page.items).toHaveLength(3);
        expect((await app.inject({ method: 'PATCH', url: '/api/v1/memories/m0', headers: bearer(admin), payload: { content: 'new', ifUnmodifiedSince: 1 } })).statusCode).toBe(200);
        const history = (await app.inject({ url: '/api/v1/memories/m0/versions', headers: bearer(admin) })).json().data;
        expect(JSON.parse(history[0].snapshot).content).toBe('经验 m0');
        expect((await app.inject({ method: 'PATCH', url: '/api/v1/memories/m0', headers: bearer(admin), payload: { content: 'stale', ifUnmodifiedSince: 1 } })).statusCode).toBe(409);
    });
    it('protects group cycles and nonempty deletes, and keeps scope names consistent', async () => {
        const create = async (name: string, parentId?: string) => (await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: bearer(admin), payload: { name, parentId } })).json().data;
        const a = await create('A'), b = await create('B', a.id);
        expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/groups/${a.id}`, headers: bearer(admin), payload: { name: 'A', parentId: b.id } })).statusCode).toBe(409);
        expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/groups/${a.id}`, headers: bearer(admin) })).statusCode).toBe(409);
        expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/groups/${b.id}`, headers: bearer(admin), payload: { name: '研发' } })).statusCode).toBe(200);
        expect((db.prepare('SELECT name FROM scopes WHERE group_id=?').get(b.id) as any).name).toBe('研发');
        expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/groups/${b.id}`, headers: bearer(admin) })).statusCode).toBe(200);
    });
    it('accepts device receipts only for the authenticated device and rejects future versions', async () => {
        const req = { method: 'POST' as const, url: '/api/v1/client/heartbeat', headers: bearer(alice) };
        expect((await app.inject({ ...req, payload: { deviceId: 'someone-else' } })).statusCode).toBe(403);
        expect((await app.inject({ ...req, payload: { policyVersion: 9999 } })).statusCode).toBe(400);
        expect((await app.inject({ ...req, payload: { version: '1.2', platform: 'macOS', policyVersion: 1, skills: [] } })).statusCode).toBe(200);
        const devices = (await app.inject({ url: '/api/v1/admin/devices', headers: bearer(admin) })).json().data;
        expect(devices.items.find((x: any) => x.userId === aliceId)).toMatchObject({ deviceId: 'device-alice', version: '1.2', policyVersion: 1 });
        expect((await app.inject({ url: '/api/v1/admin/devices', headers: bearer(alice) })).statusCode).toBe(403);
    });
    it('requires verification and optimistic concurrency before closing maintenance', async () => {
        const created = await app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', headers: bearer(admin), payload: { question: '如何报销？', ownerId: adminId } });
        const id = created.json().data.id;
        memory('verified-maintenance',org());
        const update = (state: string, version: number) => app.inject({ method: 'PATCH', url: `/api/v1/admin/maintenance/${id}`, headers: bearer(admin), payload: { state, version, note: '已补充制度并通过检索复测',resultAssetId:'verified-maintenance',resultAssetKind:'memory',verificationNote:'实际提问并确认补充材料可以回答报销流程' } });
        expect((await update('closed', 1)).statusCode).toBe(409);
        expect((await update('verified', 1)).statusCode).toBe(200);
        expect((await update('closed', 1)).statusCode).toBe(409);
        expect((await update('closed', 2)).statusCode).toBe(200);
    });
    it('keeps a working document version and rejects activation of unready/stale versions', async () => {
        const family = createDocumentFamily(db, { scopeId: org(), title: '制度', ownerId: adminId });
        for (const [id, version, state] of [['v1', 1, 'ready'], ['v2', 2, 'failed'], ['v3', 3, 'ready']] as const)
            db.prepare(`INSERT INTO documents(id,scope_id,title,source_type,content_hash,status,version,family_id,fts_status,created_at,updated_at) VALUES(?,?,'制度','txt',?,?,?,?, 'ready',1,1)`).run(id, org(), id, state, version, family);
        db.prepare('UPDATE document_families SET current_document_id=? WHERE id=?').run('v1', family);
        const detail = (await app.inject({ url: '/api/v1/docs/v1/versions', headers: bearer(admin) })).json().data;
        expect(detail.family.currentDocumentId).toBe('v1');
        expect(detail.versions).toHaveLength(3);
        const activate = (id: string, current: string) => app.inject({ method: 'POST', url: `/api/v1/docs/${id}/activate`, headers: bearer(admin), payload: { currentDocumentId: current, note: '恢复有效版本' } });
        expect((await activate('v2', 'v1')).statusCode).toBe(409);
        expect((await activate('v3', 'v1')).statusCode).toBe(200);
        expect((await activate('v1', 'v1')).statusCode).toBe(409);
    });
    it('restores a prior policy as a new monotonically increasing version', async () => {
        const get = async () => (await app.inject({ url: '/api/v1/admin/enterprise-policy', headers: bearer(admin) })).json().data;
        const original = await get();
        expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/enterprise-policy', headers: bearer(admin), payload: { ...original, allowLocalKnowledge: false } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: `/api/v1/admin/enterprise-policy/history/${original.version}/restore`, headers: bearer(admin) })).statusCode).toBe(200);
        const restored = await get();
        expect(restored.allowLocalKnowledge).toBe(true);
        expect(restored.version).toBeGreaterThan(original.version + 1);
    });
    it('serializes two automatic scans across asynchronous file publication', async () => {
        const key = await app.deps.storage.put(Buffer.from('approved text'), 'txt', 'quarantine/documents');
        db.prepare("INSERT INTO document_submissions(id,submitter_id,target_scope,title,source_type,storage_key,quarantine_storage_key,content_hash,state,scan_status,created_at) VALUES('review',?,?,'安全检查并发','txt',?,?,?,'pending','passed',1)").run(aliceId, org(), key, key, createHash('sha256').update('approved text').digest('hex'));
        const original = app.deps.storage.put.bind(app.deps.storage);
        let release: () => void = () => { }, started: () => void = () => { };
        const began = new Promise<void>(r => { started = r; }), waiting = new Promise<void>(r => { release = r; });
        app.deps.storage.put = async (...args) => { started(); await waiting; return original(...args); };
        const request = { method: 'POST' as const, url: '/api/v1/document-submissions/review/approve', headers: bearer(admin), payload: { note: 'approved' } };
        const first = app.inject(request).then(r => r);
        await began;
        expect((await app.inject(request)).statusCode).toBe(409);
        release();
        expect((await first).statusCode).toBe(200);
        expect((db.prepare("SELECT COUNT(*) AS n FROM documents WHERE content_hash=?").get(createHash('sha256').update('approved text').digest('hex')) as any).n).toBe(1);
    });
    it('previews skill source safely, changes signed distribution policy, and hides foreign personal packages', async () => {
        const zip = new JSZip();
        zip.file('SKILL.md', '# Review instructions');
        zip.file('note.txt', 'plain evidence');
        const key = await app.deps.storage.put(await zip.generateAsync({ type: 'nodebuffer' }), 'zip', 'published/skills');
        db.prepare("INSERT INTO skill_families(id,scope_id,slug,name,description,owner_id,current_version_id,created_at,updated_at) VALUES('s',?,'review','Review','safe',?,'sv',1,1)").run(org(), aliceId);
        db.prepare("INSERT INTO skill_versions(id,family_id,version,package_key,content_hash,package_bytes,manifest_json,signature,state,submitter_id,created_at,scan_status) VALUES('sv','s','1.0.0',?,'hash',100,'{}','initial','approved',?,1,'passed')").run(key, aliceId);
        const read = await app.inject({ url: '/api/v1/admin/skills/s/versions/sv/source', headers: bearer(admin) });
        expect(read.statusCode).toBe(200);
        expect(read.json().data.text).toContain('Review instructions');
        const change = await app.inject({ method: 'PATCH', url: '/api/v1/admin/skills/s/policy', headers: bearer(admin), payload: { mandatory: true, allowPersonalOverride: false, note: '统一复核标准' } });
        expect(change.statusCode).toBe(200);
        expect((db.prepare("SELECT mandatory,allow_personal_override FROM skill_families WHERE id='s'").get())).toEqual({ mandatory: 1, allow_personal_override: 0 });
        expect((db.prepare("SELECT signature FROM skill_versions WHERE id='sv'").get() as any).signature).not.toBe('initial');
        db.prepare("UPDATE skill_families SET scope_id=? WHERE id='s'").run(`personal-${aliceId}`);
        expect((await app.inject({ url: '/api/v1/admin/skills/s/versions/sv/source', headers: bearer(admin) })).statusCode).toBe(404);
    });
    it('unifies workspace counts and exposes real capability flags', async () => {
        const r = await app.inject({ url: '/api/v1/workspace', headers: bearer(admin) });
        expect(r.statusCode).toBe(200);
        expect(r.json().data.pending).toEqual({ memories: 0, documents: 0, skills: 0 });
        const caps = await app.inject({ url: '/api/v1/docs/capabilities', headers: bearer(admin) });
        expect(caps.json().data.types.some((t: any) => t.sourceType === 'txt' && t.available)).toBe(true);
        expect((await app.inject({ url: '/api/v1/notifications', headers: bearer(alice) })).statusCode).toBe(200);
        memory('contribution',org());
        const quality=await app.inject({url:'/api/v1/admin/quality/overview',headers:bearer(admin)});expect(quality.statusCode).toBe(200);expect(quality.json().data.contributions[0]).toMatchObject({displayName:'alice',memories:1});
    });
});
describe('full backup recovery', () => {
    it('verifies hashes, restores database and original assets into an empty directory, refuses overwrite', async () => {
        const key = await app.deps.storage.put(Buffer.from('immutable source'), 'txt');
        const archive = await createFullBackup(db, app.deps.cfg.storageDir);
        const target = join(temp, 'restore');
        expect((await restoreFullBackup(archive, target, true)).files).toBe(2);
        await restoreFullBackup(archive, target);
        expect((await readFile(join(target, 'storage', key))).toString()).toBe('immutable source');
        const restored = openDb({ path: join(target, 'echo.db') });
        expect((restored.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n).toBe(2);
        restored.close();
        await expect(restoreFullBackup(archive, target)).rejects.toThrow('空目录');
        const zip = await JSZip.loadAsync(archive);
        zip.file(`storage/${key}`, 'corrupted');
        await expect(restoreFullBackup(await zip.generateAsync({ type: 'nodebuffer' }), join(temp, 'bad'))).rejects.toThrow('校验失败');
    });
});
