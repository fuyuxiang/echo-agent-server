import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb, type DB } from '../src/db/index.js'
import { testConfig } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { createUser } from '../src/dao/users.js'
import { ensureOrgScope } from '../src/server.js'

let db: DB
let app: FastifyInstance
let accessToken: string

beforeEach(async () => {
  db = openDb({ path: ':memory:' })
  ensureOrgScope(db)
  await createUser(db, {
    username: 'admin',
    password: 'admin-password',
    role: 'admin',
    clearance: 2
  })
  app = buildApp({ db, cfg: testConfig(), serveWeb: false })
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'admin', password: 'admin-password', deviceId: 'llm-test' }
  })
  accessToken = login.json().data.accessToken
  const configured = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/model-config',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      chatProvider: 'openai',
      chatModel: 'approved-model',
      chatBaseUrl: 'https://upstream.example/v1',
      chatKey: 'server-only-secret',
      embedModel: 'bge-m3',
      embedDim: 1024
    }
  })
  expect(configured.statusCode).toBe(200)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  db.close()
})

describe('OpenAI-compatible LLM proxy', () => {
  it('health reads the configured snake_case row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/llm/health',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      configured: true,
      provider: 'openai',
      model: 'approved-model'
    })
  })

  it('preserves tools/tool_calls and returns raw OpenAI JSON', async () => {
    const upstream = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'approved-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
    }
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) =>
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const toolCalls = [
      { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }
    ]
    const tools = [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }
    ]
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/llm/v1/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        model: 'caller-must-not-override',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'inspect' }] },
          { role: 'assistant', content: null, tool_calls: toolCalls },
          { role: 'tool', tool_call_id: 'call-1', content: 'ok' }
        ],
        tools,
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
        stream: false
      }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(upstream)
    expect(res.json().data).toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://upstream.example/v1/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-only-secret')
    const forwarded = JSON.parse(String(init?.body))
    expect(forwarded.model).toBe('approved-model')
    expect(forwarded.tools).toEqual(tools)
    expect(forwarded.messages[1].tool_calls).toEqual(toolCalls)
    expect(forwarded.response_format).toEqual({ type: 'json_object' })
  })

  it('keeps the legacy envelope without leaking the configured key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/llm/chat',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { messages: [{ role: 'user', content: 'hello' }] }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ choices: [] })
    expect(res.body).not.toContain('server-only-secret')
  })
})
