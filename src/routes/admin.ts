import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, fail } from '../reply.js'
import { requireAdmin, requireCurator, revokeAllUserTokens, type AuthedRequest } from '../auth/jwt.js'
import {
  createUser,
  listUsers,
  updateUser,
  changePassword,
  setUserGroups,
  getUserGroups,
  findById
} from '../dao/users.js'
import { queryAuditLogs } from '../audit.js'
import { canPublishDocument, loadAccessContext } from '../auth/scopes.js'

const CreateUserSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(8, '密码至少 8 位'),
  displayName: z.string().optional(),
  email: z.string().email().optional(),
  role: z.enum(['admin', 'curator', 'member']).optional(),
  clearance: z.coerce.number().int().min(0).max(2).optional(),
  departmentId: z.string().nullable().optional(),
  groupIds: z.array(z.string()).optional()
})

const UpdateUserSchema = z.object({
  displayName: z.string().optional(),
  email: z.string().email().nullable().optional(),
  role: z.enum(['admin', 'curator', 'member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  clearance: z.coerce.number().int().min(0).max(2).optional(),
  departmentId: z.string().nullable().optional(),
  groupIds: z.array(z.string()).optional()
})

const GroupSchema = z.object({
  name: z.string().min(1).max(64),
  parentId: z.string().nullable().optional(),
  description: z.string().optional()
})

export function registerAdminRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  // ── 用户 ──────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/admin/users',
    { preHandler: [app.authenticate, requireAdmin] },
    async (_req, reply) => {
      const users = listUsers(db).map((u) => ({ ...u, groups: getUserGroups(db, u.id) }))
      return reply.send(ok(users))
    }
  )

  app.post(
    '/api/v1/admin/users',
    { preHandler: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const parsed = CreateUserSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send(fail(4001, parsed.error.issues[0]?.message ?? '参数错误'))
      }
      if([...(parsed.data.groupIds??[]),...(parsed.data.departmentId?[parsed.data.departmentId]:[])].some(id=>!db.prepare('SELECT 1 FROM groups WHERE id=?').get(id)))return reply.code(400).send(fail(4001,'部门或访问分组不存在'))
      try {
        const user = await createUser(db, parsed.data)
        app.audit(req, 'user_change', user.id, { created: true })
        return reply.send(ok(user))
      } catch (e) {
        if (String(e).includes('UNIQUE')) {
          return reply.code(409).send(fail(4091, '用户名已存在'))
        }
        throw e
      }
    }
  )

  app.patch(
    '/api/v1/admin/users/:id',
    { preHandler: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const parsed = UpdateUserSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send(fail(4001, parsed.error.issues[0]?.message ?? '参数错误'))
      }
      const { id } = req.params as { id: string }
      const actor = (req as AuthedRequest).claims

      // 不允许把自己降权或禁用自己:管理员误操作会把最后一个管理员锁在外面。
      if (id === actor.sub) {
        if (parsed.data.role && parsed.data.role !== 'admin') {
          return reply.code(400).send(fail(4002, '不能修改自己的角色'))
        }
        if (parsed.data.status === 'disabled') {
          return reply.code(400).send(fail(4003, '不能禁用自己'))
        }
      }

      if([...(parsed.data.groupIds??[]),...(parsed.data.departmentId?[parsed.data.departmentId]:[])].some(gid=>!db.prepare('SELECT 1 FROM groups WHERE id=?').get(gid)))return reply.code(400).send(fail(4001,'部门或访问分组不存在'))
      const { groupIds, ...fields } = parsed.data
      const updated = updateUser(db, id, fields)
      if (!updated) return reply.code(404).send(fail(4041, '用户不存在'))
      if (groupIds) setUserGroups(db, id, groupIds)

      app.audit(req, 'user_change', id, fields as Record<string, unknown>)
      return reply.send(ok({ ...findById(db, id)!, groups: getUserGroups(db, id) }))
    }
  )

  app.post(
    '/api/v1/admin/users/:id/password',
    { preHandler: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const body = z.object({ password: z.string().min(8) }).safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send(fail(4001, '密码至少 8 位'))
      const { id } = req.params as { id: string }
      if (!findById(db, id)) return reply.code(404).send(fail(4041, '用户不存在'))

      await changePassword(db, id, body.data.password)
      app.audit(req, 'user_change', id, { passwordReset: true })
      return reply.send(ok({ updated: true }))
    }
  )

  app.post(
    '/api/v1/admin/users/:id/revoke-sessions',
    { preHandler: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!findById(db, id)) return reply.code(404).send(fail(4041, '用户不存在'))
      revokeAllUserTokens(db, id)
      app.audit(req, 'user_change', id, { sessionsRevoked: true })
      return reply.send(ok({ revoked: true }))
    }
  )

  // ── 分组与 scope ──────────────────────────────────────────────────────
  app.get(
    '/api/v1/admin/groups',
    { preHandler: [app.authenticate, requireCurator] },
    async (_req, reply) => {
      const rows = db
        .prepare(
          `SELECT g.id, g.name, g.parent_id AS parentId, g.description,
                  s.id AS scopeId,
                  (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) AS memberCount
             FROM groups g
             LEFT JOIN scopes s ON s.kind = 'team' AND s.group_id = g.id
            ORDER BY g.name`
        )
        .all()
      return reply.send(ok(rows))
    }
  )

  /** 建组同时建对应的 team scope —— 没有 scope 的组无法承载任何文档。 */
  app.post(
    '/api/v1/admin/groups',
    { preHandler: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const parsed = GroupSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send(fail(4001, parsed.error.issues[0]?.message ?? '参数错误'))
      }
      const { name, parentId, description } = parsed.data
      if(parentId&&!db.prepare('SELECT 1 FROM groups WHERE id=?').get(parentId))return reply.code(400).send(fail(4001,'上级分组不存在'))
      const id = randomUUID()
      const scopeId = randomUUID()

      try {
        db.transaction(() => {
          db.prepare(
            'INSERT INTO groups (id, name, parent_id, description, created_at) VALUES (?,?,?,?,?)'
          ).run(id, name, parentId ?? null, description ?? null, Date.now())
          db.prepare('INSERT INTO scopes (id, kind, group_id, name) VALUES (?,?,?,?)').run(
            scopeId,
            'team',
            id,
            name
          )
        })()
      } catch (e) {
        if (String(e).includes('UNIQUE')) {
          return reply.code(409).send(fail(4092, '分组名已存在'))
        }
        throw e
      }

      app.audit(req, 'user_change', id, { groupCreated: name })
      return reply.send(ok({ id, name, parentId: parentId ?? null, scopeId }))
    }
  )


  app.patch('/api/v1/admin/groups/:id',{preHandler:[app.authenticate,requireAdmin]},async(req,reply)=>{
    const p=GroupSchema.safeParse(req.body);if(!p.success)return reply.code(400).send(fail(4001,'分组参数错误'))
    const {id}=req.params as {id:string}
    if(!db.prepare('SELECT 1 FROM groups WHERE id=?').get(id))return reply.code(404).send(fail(4041,'分组不存在'))
    const parent=p.data.parentId??null
    if(parent && !db.prepare('SELECT 1 FROM groups WHERE id=?').get(parent))return reply.code(400).send(fail(4001,'上级分组不存在'))
    if(parent===id|| (parent&&db.prepare(`WITH RECURSIVE children(id) AS (SELECT id FROM groups WHERE parent_id=? UNION SELECT g.id FROM groups g JOIN children c ON g.parent_id=c.id) SELECT 1 FROM children WHERE id=?`).get(id,parent)))return reply.code(409).send(fail(4091,'分组层级不能形成循环'))
    try {db.transaction(()=>{db.prepare('UPDATE groups SET name=?,parent_id=?,description=? WHERE id=?').run(p.data.name,parent,p.data.description??null,id);db.prepare("UPDATE scopes SET name=? WHERE group_id=? AND kind='team'").run(p.data.name,id)})()}catch(e){if(String(e).includes('UNIQUE'))return reply.code(409).send(fail(4091,'分组名称已存在'));throw e}
    app.audit(req,'user_change',id,{groupUpdated:p.data});return reply.send(ok({updated:true}))
  })
  app.delete('/api/v1/admin/groups/:id',{preHandler:[app.authenticate,requireAdmin]},async(req,reply)=>{
    const {id}=req.params as {id:string}
    if(!db.prepare('SELECT 1 FROM groups WHERE id=?').get(id))return reply.code(404).send(fail(4041,'分组不存在'))
    const refs=db.prepare(`SELECT (SELECT COUNT(*) FROM groups WHERE parent_id=?) + (SELECT COUNT(*) FROM user_groups WHERE group_id=?) + (SELECT COUNT(*) FROM users WHERE department_id=?) + (SELECT COUNT(*) FROM documents WHERE scope_id IN (SELECT id FROM scopes WHERE group_id=?)) + (SELECT COUNT(*) FROM org_memories WHERE scope_id IN (SELECT id FROM scopes WHERE group_id=?)) + (SELECT COUNT(*) FROM skill_families WHERE scope_id IN (SELECT id FROM scopes WHERE group_id=?)) + (SELECT COUNT(*) FROM promotions WHERE target_scope IN (SELECT id FROM scopes WHERE group_id=?)) + (SELECT COUNT(*) FROM document_submissions WHERE target_scope IN (SELECT id FROM scopes WHERE group_id=?)) AS n`).get(id,id,id,id,id,id,id,id) as any
    if(refs.n)return reply.code(409).send(fail(4091,'分组仍有子分组、成员或知识记录，无法删除'))
    db.prepare('DELETE FROM groups WHERE id=?').run(id);app.audit(req,'user_change',id,{groupDeleted:true});return reply.send(ok({deleted:true}))
  })

  /** 可见性单元列表。上传文档时需要 scope_id,前端从这里取。 */
  app.get(
    '/api/v1/scopes',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const claims = (req as AuthedRequest).claims
      // 普通成员只看到自己可见的 scope,管理员看全部 —— 否则前端上传
      // 下拉框会列出他无权写入的范围。
      const sql =
        claims.role === 'admin'
          ? `SELECT s.id, s.kind, s.name, s.group_id AS groupId,
                    s.owner_user_id AS ownerUserId
               FROM v_effective_scopes s WHERE s.kind!='personal' OR s.owner_user_id=? ORDER BY s.kind, s.name`
          : `SELECT s.id, s.kind, s.name, s.group_id AS groupId,
                    s.owner_user_id AS ownerUserId
               FROM v_effective_scopes s
               JOIN v_user_scopes v ON v.scope_id = s.id
              WHERE v.user_id = ?
              ORDER BY s.kind, s.name`
      const rows =
        claims.role === 'admin'
          ? db.prepare(sql).all(claims.sub)
          : db.prepare(sql).all(claims.sub)
      const access = loadAccessContext(db, claims.sub)
      return reply.send(ok((rows as Array<Record<string, unknown> & { id: string }>).map((scope) => ({
        ...scope,
        canPublishDocuments: canPublishDocument(db, access, claims.role, scope.id)
      }))))
    }
  )

  // ── 审计 ──────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/admin/audit',
    { preHandler: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const p=z.object({action:z.string().max(80).optional(),actorId:z.string().max(200).optional(),from:z.coerce.number().int().min(0).optional(),to:z.coerce.number().int().min(0).optional(),limit:z.coerce.number().int().min(1).max(200).default(100),offset:z.coerce.number().int().min(0).default(0),page:z.coerce.number().int().min(1).optional()}).safeParse(req.query)
      if(!p.success)return reply.code(400).send(fail(4001,'审计筛选参数错误'))
      const q=p.data
      const items=queryAuditLogs(db,{...q,offset:q.page?(q.page-1)*q.limit:q.offset})
      if(!q.page)return reply.send(ok(items))
      const where:string[]=[],args:unknown[]=[]
      for(const [clause,value] of [['action = ?',q.action],['actor_id = ?',q.actorId],['created_at >= ?',q.from],['created_at <= ?',q.to]] as const)if(value!==undefined){where.push(clause);args.push(value)}
      const total=(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where.length?'WHERE '+where.join(' AND '):''}`).get(...args) as any).n
      return reply.send(ok({items,total,page:q.page,size:q.limit}))
    }
  )
}
