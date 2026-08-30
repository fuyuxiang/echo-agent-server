import { describe, expect, it } from 'vitest'
import { sourceCapabilityError } from '../../src/kb/ingest/capabilities.js'

const unavailable = {
  vlmClient: { configured: false, model: null, async caption() { return '' } },
  transcriptionClient: {
    configured: false,
    model: 'whisper-1',
    async transcribe() { return [] }
  }
}

describe('上传前摄取能力校验', () => {
  it('普通办公文档不依赖 VLM 或转写', async () => {
    await expect(sourceCapabilityError('md', unavailable)).resolves.toBeNull()
  })

  it('未配置图片理解时明确拒绝图片', async () => {
    await expect(sourceCapabilityError('image', unavailable)).resolves.toContain('图片理解')
  })

  it('未配置转写时明确拒绝音频', async () => {
    await expect(sourceCapabilityError('audio', unavailable)).resolves.toContain('转写')
  })
})
