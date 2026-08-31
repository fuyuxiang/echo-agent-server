import { z } from 'zod'
import type { Config } from '../config.js'
import type { DB } from '../db/index.js'
import { resolveChatConfig } from './chat-config.js'

export interface StructuredChatRequest<T> {
  schema: z.ZodType<T>
  system: string
  user: string
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * 调用服务端统一配置的聊天模型，并把结果约束为 JSON。
 *
 * 不依赖供应商特有的 response_format：不少“OpenAI-compatible”网关只实现
 * 了基础 chat/completions。服务端仍会从 Markdown fence 中提取 JSON，并用
 * Zod 做最终边界校验；任何网络、格式或 schema 错误都返回 null，由 Agentic
 * 工作流走确定性降级，绝不让模型输出直接进入检索或答案链路。
 */
export async function callStructuredChat<T>(
  db: DB,
  cfg: Config,
  request: StructuredChatRequest<T>
): Promise<T | null> {
  const chat = resolveChatConfig(db, cfg)
  if (!chat.configured || !chat.key || !chat.model) return null

  const ctrl = new AbortController()
  const abortFromCaller = (): void => ctrl.abort()
  if (request.signal?.aborted) ctrl.abort()
  else request.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => ctrl.abort(), request.timeoutMs ?? cfg.agenticReasoningTimeoutMs)

  try {
    const response = await fetch(`${chat.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${chat.key}`
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: chat.model,
        temperature: 0,
        stream: false,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user }
        ]
      })
    })
    if (!response.ok) return null
    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const content = json.choices?.[0]?.message?.content
    if (!content) return null
    const parsed = extractJson(content)
    if (parsed === null) return null
    const validated = request.schema.safeParse(parsed)
    return validated.success ? validated.data : null
  } catch (error) {
    // 客户端取消必须继续向上传播，路由据此停止检索、生成和质量事件写入。
    if (request.signal?.aborted) throw error
    return null
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abortFromCaller)
  }
}

/** 从纯 JSON 或 ```json ... ``` 响应中提取第一个完整对象。 */
export function extractJson(content: string): unknown | null {
  const trimmed = content.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(unfenced.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}
