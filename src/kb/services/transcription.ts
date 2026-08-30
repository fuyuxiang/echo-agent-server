import type { Config } from '../../config.js'

export interface TranscriptionSegment {
  startMs: number
  endMs: number
  text: string
}

export interface TranscriptionClient {
  readonly configured: boolean
  readonly model: string
  transcribe(buf: Buffer, fileName: string, mime: string): Promise<TranscriptionSegment[]>
}

interface TranscriptionResponse {
  text?: string
  duration?: number
  segments?: Array<{ start?: number; end?: number; text?: string }>
}

/** OpenAI-compatible /audio/transcriptions client with segment timestamps. */
export function createTranscriptionClient(
  cfg?: Config,
  warn?: (message: string) => void
): TranscriptionClient {
  const url = cfg?.transcribeUrl ?? process.env.ECHO_TRANSCRIBE_URL
  const key = cfg?.transcribeKey ?? process.env.ECHO_TRANSCRIBE_KEY
  const model = cfg?.transcribeModel ?? process.env.ECHO_TRANSCRIBE_MODEL ?? 'whisper-1'
  const timeoutMs = cfg?.transcribeTimeoutMs ?? 10 * 60_000
  if (!url) {
    warn?.('未配置音视频转写服务，音频/视频上传将被拒绝')
    return {
      configured: false,
      model,
      async transcribe() {
        throw new Error('音视频转写服务未配置')
      }
    }
  }

  return {
    configured: true,
    model,
    async transcribe(buf: Buffer, fileName: string, mime: string) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), fileName)
      form.append('model', model)
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'segment')
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: key ? { authorization: `Bearer ${key}` } : {},
          body: form,
          signal: ctrl.signal
        })
      } catch (error) {
        if (ctrl.signal.aborted) throw new Error(`转写服务请求超时（${timeoutMs}ms）`)
        throw error
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`转写 API ${response.status}: ${detail.slice(0, 300)}`)
      }
      const json = await response.json() as TranscriptionResponse
      const segments = (json.segments ?? [])
        .filter((segment) => segment.text?.trim())
        .map((segment) => ({
          startMs: Math.max(0, Math.round((segment.start ?? 0) * 1000)),
          endMs: Math.max(0, Math.round((segment.end ?? segment.start ?? 0) * 1000)),
          text: segment.text!.trim()
        }))
      if (segments.length > 0) return segments
      const text = json.text?.trim()
      if (text) {
        return [{ startMs: 0, endMs: Math.max(0, Math.round((json.duration ?? 0) * 1000)), text }]
      }
      throw new Error('转写服务返回空文本')
    }
  }
}
