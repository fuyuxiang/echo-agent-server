import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  createAudioParser,
  createVideoParser,
  ffmpegAvailable,
  segmentsToBlocks,
  mediaParserFor,
  extOf
} from '../../src/kb/parsers/media.js'

const execFileAsync = promisify(execFile)

// whisper 与 ffmpeg 都不在测试栈里,所以测不到的 transcribe/extractAudio
// 不测。segmentsToBlocks 与 mediaParserFor 是纯函数,值得钉住 —— 它们的
// 行为直接决定 chunk 数、引用定位精度、文件类型分发。

describe('segmentsToBlocks 块划分', () => {
  it('空段落返回空', () => {
    expect(segmentsToBlocks([])).toEqual([])
  })

  it('所有段落挤进同一 30s 桶', () => {
    const blocks = segmentsToBlocks([
      { startMs: 0, endMs: 1000, text: '你好' },
      { startMs: 1000, endMs: 2000, text: '世界' }
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('你好 世界')
    expect(blocks[0].startMs).toBe(0)
    expect(blocks[0].endMs).toBe(2000)
    expect(blocks[0].kind).toBe('transcript')
  })

  it('跨过 30s 桶边界就切', () => {
    const blocks = segmentsToBlocks([
      { startMs: 0, endMs: 1000, text: 'A' },
      // 35s 处,跨过 bucketStart=0 + 30s 的边界
      { startMs: 35000, endMs: 36000, text: 'B' }
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toBe('A')
    expect(blocks[1].text).toBe('B')
    // 第二个桶的起点是 35000 而不是 0 —— 锚定到首段 startMs
    expect(blocks[1].startMs).toBe(35000)
  })

  it('跨多段且每段都不出桶时仍是一个块', () => {
    const blocks = segmentsToBlocks([
      { startMs: 0, endMs: 5000, text: 'A' },
      { startMs: 5000, endMs: 10000, text: 'B' },
      { startMs: 10000, endMs: 15000, text: 'C' }
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('A B C')
  })

  it('末尾的尾段单独成块', () => {
    const blocks = segmentsToBlocks([
      { startMs: 0, endMs: 1000, text: 'first' },
      { startMs: 50000, endMs: 51000, text: 'last' }
    ])
    expect(blocks).toHaveLength(2)
  })
})

describe('mediaParserFor 文件分发', () => {
  it('音频后缀返回 audioParser', () => {
    for (const ext of ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus']) {
      const p = mediaParserFor(`meeting.${ext}`)
      expect(p, `meeting.${ext} 应当被识别为音频`).not.toBeNull()
    }
  })

  it('视频后缀返回 videoParser', () => {
    for (const ext of ['mp4', 'mov', 'mkv', 'webm', 'avi']) {
      const p = mediaParserFor(`talk.${ext}`)
      expect(p, `talk.${ext} 应当被识别为视频`).not.toBeNull()
    }
  })

  it('大小写不敏感', () => {
    expect(mediaParserFor('audio.MP3')).not.toBeNull()
    expect(mediaParserFor('video.MP4')).not.toBeNull()
  })

  it('非媒体后缀返回 null(由上游走其它解析器)', () => {
    expect(mediaParserFor('doc.pdf')).toBeNull()
    expect(mediaParserFor('doc.md')).toBeNull()
    expect(mediaParserFor('archive.zip')).toBeNull()
  })

  it('audio 与 video 解析器不是同一个对象(行为不同)', () => {
    // 视频会先抽音轨再转写,音频直接转写 —— 行为不同,实例必须分离
    expect(mediaParserFor('a.mp3')).not.toBe(mediaParserFor('a.mp4'))
  })
})

describe('extOf 工具', () => {
  it('大小写归一化', () => {
    expect(extOf('A.MP3')).toBe('.mp3')
  })

  it('无后缀返回空串', () => {
    expect(extOf('README')).toBe('')
  })

  it('多点的取最后一个', () => {
    expect(extOf('archive.tar.gz')).toBe('.gz')
  })
})

describe('注入式转写解析', () => {
  it('音频结果保留可跳转的时间范围', async () => {
    const parser = createAudioParser({
      configured: true,
      model: 'test-whisper',
      async transcribe() {
        return [{ startMs: 1200, endMs: 2800, text: '会议结论' }]
      }
    })
    await expect(parser.parse(Buffer.from('audio'), {
      docId: 'doc-1',
      fileName: 'meeting.mp3'
    })).resolves.toEqual([{
      text: '会议结论',
      location: { kind: 'timestamp', startMs: 1200, endMs: 2800 }
    }])
  })

  it('视频用 ffmpeg 抽取为 mp3 后再转写', async () => {
    if (!(await ffmpegAvailable())) return
    const dir = await mkdtemp(join(tmpdir(), 'echo-video-test-'))
    try {
      const videoPath = join(dir, 'meeting.mp4')
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
        '-c:a', 'aac', videoPath
      ])
      const video = await readFile(videoPath)
      let received: { name: string; mime: string; bytes: number } | null = null
      const parser = createVideoParser({
        configured: true,
        model: 'test-whisper',
        async transcribe(buf, name, mime) {
          received = { name, mime, bytes: buf.length }
          return [{ startMs: 0, endMs: 200, text: '视频语音' }]
        }
      })
      const units = await parser.parse(video, { docId: 'video-doc', fileName: 'meeting.mp4' })
      expect(received).toMatchObject({ name: 'segment-0.mp3', mime: 'audio/mpeg' })
      expect(received?.bytes).toBeGreaterThan(0)
      expect(units[0]).toEqual({
        text: '视频语音',
        location: { kind: 'timestamp', startMs: 0, endMs: 200 }
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
