import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConfig } from '../../../src/config.js'
import { createTranscriptionClient } from '../../../src/kb/services/transcription.js'

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI-compatible 音视频转写', () => {
  it('未配置时明确不可用', async () => {
    const client = createTranscriptionClient(testConfig())
    expect(client.configured).toBe(false)
    await expect(client.transcribe(Buffer.from('audio'), 'a.mp3', 'audio/mpeg'))
      .rejects.toThrow('未配置')
  })

  it('发送 multipart、鉴权并转换秒级时间戳', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      text: '完整文本',
      segments: [
        { start: 0.25, end: 1.5, text: ' 第一段 ' },
        { start: 1.5, end: 2.75, text: '第二段' }
      ]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createTranscriptionClient(testConfig({
      transcribeUrl: 'https://speech.example/v1/audio/transcriptions',
      transcribeKey: 'speech-key',
      transcribeModel: 'whisper-prod'
    }))
    const segments = await client.transcribe(Buffer.from('audio'), 'meeting.mp3', 'audio/mpeg')
    expect(segments).toEqual([
      { startMs: 250, endMs: 1500, text: '第一段' },
      { startMs: 1500, endMs: 2750, text: '第二段' }
    ])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://speech.example/v1/audio/transcriptions')
    expect((init as RequestInit).headers).toEqual({ authorization: 'Bearer speech-key' })
    const form = (init as RequestInit).body as FormData
    expect(form.get('model')).toBe('whisper-prod')
    expect(form.get('response_format')).toBe('verbose_json')
  })

  it('无 segments 时保留完整文本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ text: '整段转写', duration: 3.2 }), { status: 200 }
    )))
    const client = createTranscriptionClient(testConfig({ transcribeUrl: 'https://speech.example' }))
    await expect(client.transcribe(Buffer.from('x'), 'a.wav', 'audio/wav')).resolves.toEqual([
      { startMs: 0, endMs: 3200, text: '整段转写' }
    ])
  })
})
