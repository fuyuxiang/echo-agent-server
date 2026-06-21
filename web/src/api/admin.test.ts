import { describe, expect, it, beforeEach } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import client from './client'
import { listUsers, createUser, updateUser, createGroup } from './admin'

const mock = new MockAdapter(client)
beforeEach(() => mock.reset())

describe('admin api', () => {
  it('lists users', async () => {
    mock.onGet('/api/admin/users').reply(200, { code: 0, msg: 'ok', data: [{ id: 'u1', username: 'a', role: 'admin', groupId: null }] })
    const users = await listUsers()
    expect(users).toHaveLength(1)
    expect(users[0].username).toBe('a')
  })

  it('creates a user with payload', async () => {
    mock.onPost('/api/admin/users').reply((cfg) => {
      expect(JSON.parse(cfg.data)).toMatchObject({ username: 'bob', password: 'p' })
      return [200, { code: 0, msg: 'ok', data: { id: 'u2', username: 'bob', role: 'member', groupId: null } }]
    })
    const u = await createUser({ username: 'bob', password: 'p' })
    expect(u.id).toBe('u2')
  })

  it('patches a user by id', async () => {
    mock.onPatch('/api/admin/users/u1').reply(200, { code: 0, msg: 'ok', data: { updated: true } })
    const r = await updateUser('u1', { disabled: true })
    expect(r.updated).toBe(true)
  })

  it('creates a group', async () => {
    mock.onPost('/api/admin/groups').reply(200, { code: 0, msg: 'ok', data: { id: 'g1', name: 'team' } })
    const g = await createGroup('team')
    expect(g.name).toBe('team')
  })
})
