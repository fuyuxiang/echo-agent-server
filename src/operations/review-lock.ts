import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fail } from '../reply.js';
/** Serialize manual decisions across async scanning/storage work, including withdraw. */
export function registerReviewLocks(app: FastifyInstance): void {
    const held = new WeakMap<FastifyRequest, {
        table: string;
        id: string;
        owner: string;
    }>();
    app.addHook('onRoute', route => {
        if (route.method !== 'POST')
            return;
        const match = String(route.url).match(/^\/api\/v1\/(document-submissions|promotions|admin\/skill-submissions)\/:id\/(reject|withdraw)$/);
        if (!match)
            return;
        const table = { 'document-submissions': 'document_submissions', promotions: 'promotions', 'admin/skill-submissions': 'skill_versions' }[match[1]]!;
        const acquire = async (req: FastifyRequest, reply: any) => {
            const { id } = req.params as {
                id: string;
            };
            const owner = randomUUID();
            const now = Date.now();
            const row = app.deps.db.prepare(`SELECT state FROM ${table} WHERE id=?`).get(id) as {
                state: string;
            } | undefined;
            if (!row || row.state !== 'pending')
                return;
            const changed = app.deps.db.prepare(`UPDATE ${table} SET review_lock=?,review_lease_until=? WHERE id=? AND state='pending' AND (review_lock IS NULL OR review_lease_until<?)`).run(owner, now + 300000, id, now);
            if (!changed.changes)
                return reply.code(409).send(fail(4091, '该提交正在被处理，请稍后刷新'));
            held.set(req, { table, id, owner });
        };
        route.preHandler = [...(Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : []), acquire];
    });
    app.addHook('onResponse', async (req) => { const lock = held.get(req); if (lock) {
        app.deps.db.prepare(`UPDATE ${lock.table} SET review_lock=NULL,review_lease_until=NULL WHERE id=? AND review_lock=?`).run(lock.id, lock.owner);
        held.delete(req);
    } });
}
