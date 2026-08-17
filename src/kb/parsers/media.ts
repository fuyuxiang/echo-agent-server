import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Parser, ParserUnit } from './types.js'
import type { Block } from '../ingest/chunk.js'

/**
 * 音视频解析器。
 *
 * 视频先抽音轨再走 whisper(ffmpeg whisper 模式或 faster-whisper CLI),
 * 音频直接 whisper。两种都产出一组带时间戳的段落,被结构感知分块器
 * 当作 transcript 处理。
 *
 * 引用跳转靠 startMs/endMs:回看页面定位到该秒。前端在做引用卡片时已有
 * 时间戳格式化,这里不再重复。
 *
 * 转写产物不进 doc_text 里 —— 那是模型回答时直接当材料用的;transcript
 * 是有定位的素材,作为 chunk modality='transcript' 写库,引用打开时跳到
 * 对应秒,而不是把整段转写甩给用户。
 */

const MAX_AUDIO_BYTES = 200 * 1024 * 1024 // 200MB 视频上限(防 OOM)

/**
 * 调 whisper CLI。
 *
 * faster-whisper(纯本地)与 openai-whisper(也支持)都提供 `whisper`
 * 子命令。这里只走 faster-whisper 的 --json 输出格式,因其支持
 * segment 级时间戳。whisper 不在则降级抛错 —— 部署文档需说明依赖。
 */
async function transcribe(audioPath: string): Promise<TranscriptionSegment[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'faster-whisper',
      [
        audioPath,
        '--language', 'auto',
        '--output_format', 'json',
        '--model', 'small',          // 权衡质量与速度;生产可调
        '--compute_type', 'int8',     // CPU 上跑得动
        '--beam_size', '1',
        '--vad_filter', 'true',
        '--vad_min_silence_duration_ms', '500'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => reject(new Error(`whisper 启动失败:${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        // 找不到二进制(ENOENT)与运行失败的报错应该明显区分
        reject(new Error(`whisper 退出 ${code}: ${stderr.slice(-300)}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as {
          segments?: { start: number; end: number; text: string }[]
        }
        const segs = (parsed.segments ?? [])
          .filter((s) => s.text?.trim())
          .map((s) => ({
            startMs: Math.floor(s.start * 1000),
            endMs: Math.floor(s.end * 1000),
            text: s.text.trim()
          }))
        resolve(segs)
      } catch (e) {
        reject(new Error(`whisper 输出解析失败:${(e as Error).message}`))
      }
    })
  })
}

async function extractAudio(videoPath: string, workDir: string): Promise<string> {
  const audioPath = join(workDir, 'extracted.wav')
  return new Promise((resolve, reject) => {
    // 16kHz 单声道 wav:whisper 推荐的输入格式,免去内部重采样
    const args = [
      '-y',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 'wav',
      audioPath
    ]
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => reject(new Error(`ffmpeg 启动失败:${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg 退出 ${code}: ${stderr.slice(-300)}`))
        return
      }
      resolve(audioPath)
    })
  })
}

/** 流式读文件并算 size,不把整个文件装进内存。 */
async function fileSize(path: string): Promise<number> {
  return statSync(path).size
}

/** 上限 200MB —— 比 admin web 上传限制略宽,给批处理留余地。 */
async function checkSize(path: string, kind: string): Promise<void> {
  const size = await fileSize(path)
  if (size > MAX_AUDIO_BYTES) {
    throw new Error(
      `${kind} 文件超过 ${Math.floor(MAX_AUDIO_BYTES / 1048576)}MB 上限`
    )
  }
}

/**
 * 把大转写按 VAD 边界切成多个 block,避免一个 block 跨越多个不相关话题。
 * 短段落直接成块,长段落每 30s 切一块。
 */
export function segmentsToBlocks(segments: TranscriptionSegment[]): Block[] {
  if (segments.length === 0) return []
  const blocks: Block[] = []
  let current: TranscriptionSegment[] = []
  let bucketStart = segments[0].startMs
  const BUCKET_MS = 30_000

  for (const seg of segments) {
    if (current.length === 0) {
      current.push(seg)
      bucketStart = seg.startMs
      continue
    }
    if (seg.startMs - bucketStart > BUCKET_MS) {
      blocks.push({
        kind: 'transcript',
        text: current.map((s) => s.text).join(' '),
        startMs: bucketStart,
        endMs: current[current.length - 1].endMs
      })
      current = [seg]
      bucketStart = seg.startMs
    } else {
      current.push(seg)
    }
  }
  if (current.length > 0) {
    blocks.push({
      kind: 'transcript',
      text: current.map((s) => s.text).join(' '),
      startMs: bucketStart,
      endMs: current[current.length - 1].endMs
    })
  }
  return blocks
}

interface TranscriptionSegment {
  startMs: number
  endMs: number
  text: string
}

const audioExtensions = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus'])
const videoExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi'])

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function blocksToUnits(blocks: Block[]): ParserUnit[] {
  return blocks.map((b) => ({
    text: b.text,
    location: b.kind === 'transcript'
      ? { kind: 'timestamp' as const, startMs: b.startMs ?? 0, endMs: b.endMs ?? 0 }
      : { kind: 'plain' as const, offset: 0, length: b.text.length }
  }))
}

export const audioParser: Parser = {
  sourceType: 'audio',
  async parse(buf, meta) {
    const tmpDir = await mkdtemp(join(tmpdir(), 'echo-audio-'))
    try {
      // 解析器拿到的只是 Buffer —— 必须先落盘才能用 ffmpeg/whisper 这类
      // CLI 工具。落盘在临时目录,解析完即清,文件不进入存储。
      const audioPath = join(tmpDir, `audio-${meta.docId}${extOf(meta.fileName)}`)
      await writeFile(audioPath, buf)
      await checkSize(audioPath, 'audio')
      const segs = await transcribe(audioPath)
      return blocksToUnits(segmentsToBlocks(segs))
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export const videoParser: Parser = {
  sourceType: 'video',
  async parse(buf, meta) {
    const tmpDir = await mkdtemp(join(tmpdir(), 'echo-video-'))
    try {
      // 视频先存盘,再让 ffmpeg 抽音轨,然后才转写。三步:落盘是必要的,
      // 因为 ffmpeg/whisper 都是按路径读流式文件,不能从 stdin 推。
      const videoPath = join(tmpDir, `video-${meta.docId}${extOf(meta.fileName)}`)
      const audioPath = join(tmpDir, 'extracted.wav')
      await writeFile(videoPath, buf)
      await checkSize(videoPath, 'video')
      await extractAudio(videoPath, audioPath)
      try {
        const segs = await transcribe(audioPath)
        return blocksToUnits(segmentsToBlocks(segs))
      } finally {
        await rm(audioPath, { force: true }).catch(() => {})
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** 工厂:根据文件名挑 audio 或 video 解析器。 */
export function mediaParserFor(fileName: string): Parser | null {
  const ext = extOf(fileName)
  if (audioExtensions.has(ext)) return audioParser
  if (videoExtensions.has(ext)) return videoParser
  return null
}

/**
 * 流式读 wav 头部估算时长。
 *
 * 解析器在解析时已经走过 ffmpeg,完整 ffprobe 反而是冗余的 —— 只在路由
 * 接受上传前用来显示"这个文件大概转 1 小时"。有错误就返回 null,UI
 * 退回到显示字节数。
 */
export async function estimateDuration(path: string): Promise<number | null> {
  try {
    return new Promise((resolve) => {
      const child = spawn(
        'ffprobe',
        [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          path
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.on('error', () => resolve(null))
      child.on('close', () => {
        const sec = Number(out.trim())
        resolve(Number.isFinite(sec) && sec > 0 ? Math.floor(sec * 1000) : null)
      })
    })
  } catch {
    // 估算失败不阻塞,UI 退回到显示字节数
    return null
  }
}
