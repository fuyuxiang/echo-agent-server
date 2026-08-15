import { describe, it, expect } from 'vitest'
import { segmentsToBlocks, mediaParserFor, extOf } from '../../src/kb/parsers/media.js'

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
