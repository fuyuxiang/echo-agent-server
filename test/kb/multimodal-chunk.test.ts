import { describe, expect, it } from 'vitest'
import { chunkBlocks } from '../../src/kb/ingest/chunk.js'

describe('视频多模态索引', () => {
  it('画面说明与音轨文字保留各自的类型和时间定位', () => {
    const chunks = chunkBlocks([
      { kind: 'caption', text: '画面中的红色图表', startMs: 0, endMs: 5000 },
      { kind: 'transcript', text: '讲解图表数据', startMs: 0, endMs: 3000 }
    ])
    expect(chunks).toMatchObject([
      { modality: 'caption', startMs: 0, endMs: 5000 },
      { modality: 'transcript', startMs: 0, endMs: 3000 }
    ])
  })
})
