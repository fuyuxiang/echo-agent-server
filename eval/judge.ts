/**
 * LLM-as-judge —— 用配置的 chat 模型评估 faithfulness 与 relevance。
 *
 * 仅当环境变量 ECHO_EVAL_JUDGE_URL / ECHO_EVAL_JUDGE_MODEL 存在时启用;
 * 否则 eval runner 会回退到基于引用的近似评分(见 run.ts 的 fallback)。
 *
 * 调用方式:OpenAI 兼容 chat completions,返回 JSON:
 *   { "score": 0 | 1, "reason": "..." }
 *
 * 设计要点:
 *   - 评分只输出 0/1,简化提示词与解析;
 *   - judge 失败时不抛错,而是返回 null,让 fallback 接管;
 *   - 超时 5s,避免单条题目被 judge 服务拖垮。
 */

interface JudgeResult {
  score: 0 | 1
  reason?: string
}

export interface JudgeClient {
  faithful(question: string, points: string[], evidence: string): Promise<JudgeResult | null>
  relevant(question: string, expectedDocIds: string[], docTitles: string[]): Promise<JudgeResult | null>
  close(): void
}

const TIMEOUT_MS = 5000

export function buildJudge(): JudgeClient | null {
  const url = process.env.ECHO_EVAL_JUDGE_URL
  const key = process.env.ECHO_EVAL_JUDGE_KEY
  const model = process.env.ECHO_EVAL_JUDGE_MODEL
  if (!url || !model) return null

  async function chat(prompt: string): Promise<string> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {})
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '你是严格的质检员,只输出合法 JSON。' },
            { role: 'user', content: prompt }
          ],
          temperature: 0,
          response_format: { type: 'json_object' }
        }),
        signal: ctrl.signal
      })
      if (!res.ok) throw new Error(`judge http ${res.status}`)
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      return body.choices?.[0]?.message?.content ?? '{}'
    } finally {
      clearTimeout(timer)
    }
  }

  function parse(text: string): JudgeResult | null {
    try {
      const obj = JSON.parse(text) as { score?: number; reason?: string }
      if (obj.score === 0 || obj.score === 1) {
        return { score: obj.score, reason: obj.reason }
      }
      return null
    } catch {
      return null
    }
  }

  return {
    async faithful(question, points, evidence) {
      const prompt =
        `判断"答案中的关键点是否被引用材料支持"。\n` +
        `问题:${question}\n关键点:${points.join(' | ')}\n` +
        `引用材料:\n${evidence.slice(0, 4000)}\n` +
        `仅输出 JSON:{ "score": 0 | 1, "reason": "一句话" }。1=全部支持,0=不支持。`
      try {
        return parse(await chat(prompt))
      } catch {
        return null
      }
    },
    async relevant(question, expectedDocIds, docTitles) {
      const prompt =
        `判断"答案是否切题且来自期望文档"。\n` +
        `问题:${question}\n期望文档:${expectedDocIds.join(',')}\n` +
        `实际返回文档标题:${docTitles.join(' | ')}\n` +
        `仅输出 JSON:{ "score": 0 | 1, "reason": "一句话" }。1=切题且包含期望,0=跑题。`
      try {
        return parse(await chat(prompt))
      } catch {
        return null
      }
    },
    close() {
      // 当前实现没有长连接,无需清理。
    }
  }
}
