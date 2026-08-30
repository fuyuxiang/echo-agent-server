import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Parser, ParserUnit } from './types.js'
import type { Block } from '../ingest/chunk.js'
import {
  createTranscriptionClient,
  type TranscriptionClient,
  type TranscriptionSegment
} from '../services/transcription.js'

const MAX_MEDIA_BYTES = 200 * 1024 * 1024
export const DIRECT_TRANSCRIPTION_MAX_BYTES = 20 * 1024 * 1024
const MEDIA_SEGMENT_MS = 60 * 60_000
const audioExtensions = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus'])
const videoExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi'])

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function mimeOf(name: string, fallback = 'application/octet-stream'): string {
  const mime: Record<string, string> = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus'
  }
  return mime[extOf(name)] ?? fallback
}

function checkSize(buf: Buffer, kind: string): void {
  if (buf.length > MAX_MEDIA_BYTES) {
    throw new Error(`${kind} 文件超过 ${Math.floor(MAX_MEDIA_BYTES / 1048576)}MB 上限`)
  }
}

async function extractAudioSegments(inputPath: string, workDir: string): Promise<string[]> {
  const outputPattern = join(workDir, 'segment-%03d.mp3')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y', '-i', inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
      '-codec:a', 'libmp3lame', '-b:a', '32k', '-f', 'segment',
      '-segment_time', String(MEDIA_SEGMENT_MS / 1000), '-reset_timestamps', '1', outputPattern
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()))
    child.on('error', (error) => reject(new Error(`ffmpeg 启动失败: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出 ${code}: ${stderr.slice(-300)}`))
    })
  })
  const paths = (await readdir(workDir))
    .filter((name) => /^segment-\d+\.mp3$/.test(name))
    .sort()
    .map((name) => join(workDir, name))
  if (paths.length === 0) throw new Error('ffmpeg 未提取到可转写的音轨')
  return paths
}

async function transcribeFiles(
  transcriber: TranscriptionClient,
  paths: string[]
): Promise<TranscriptionSegment[]> {
  const all: TranscriptionSegment[] = []
  for (let index = 0; index < paths.length; index += 1) {
    const audio = await readFile(paths[index])
    const offset = index * MEDIA_SEGMENT_MS
    const segments = await transcriber.transcribe(audio, `segment-${index}.mp3`, 'audio/mpeg')
    all.push(...segments.map((segment) => ({
      ...segment,
      startMs: segment.startMs + offset,
      endMs: segment.endMs + offset
    })))
  }
  return all
}

let ffmpegProbe: Promise<boolean> | null = null

/** Cached binary probe used by readiness and video-upload admission. */
export function ffmpegAvailable(): Promise<boolean> {
  ffmpegProbe ??= new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
  return ffmpegProbe
}

export function segmentsToBlocks(segments: TranscriptionSegment[]): Block[] {
  if (segments.length === 0) return []
  const blocks: Block[] = []
  let current: TranscriptionSegment[] = []
  let bucketStart = segments[0].startMs
  const bucketMs = 30_000

  const flush = (): void => {
    if (current.length === 0) return
    blocks.push({
      kind: 'transcript',
      text: current.map((segment) => segment.text).join(' '),
      startMs: bucketStart,
      endMs: current[current.length - 1].endMs
    })
  }
  for (const segment of segments) {
    if (current.length > 0 && segment.startMs - bucketStart > bucketMs) {
      flush()
      current = []
    }
    if (current.length === 0) bucketStart = segment.startMs
    current.push(segment)
  }
  flush()
  return blocks
}

function blocksToUnits(blocks: Block[]): ParserUnit[] {
  return blocks.map((block) => ({
    text: block.text,
    location: block.kind === 'transcript'
      ? { kind: 'timestamp' as const, startMs: block.startMs ?? 0, endMs: block.endMs ?? 0 }
      : { kind: 'plain' as const, offset: 0, length: block.text.length }
  }))
}

export function createAudioParser(transcriber: TranscriptionClient): Parser {
  return {
    sourceType: 'audio',
    async parse(buf, meta) {
      checkSize(buf, 'audio')
      if (buf.length <= DIRECT_TRANSCRIPTION_MAX_BYTES) {
        const segments = await transcriber.transcribe(buf, meta.fileName, mimeOf(meta.fileName))
        return blocksToUnits(segmentsToBlocks(segments))
      }
      const workDir = await mkdtemp(join(tmpdir(), 'echo-audio-'))
      try {
        const inputPath = join(workDir, `audio-${meta.docId}${extOf(meta.fileName)}`)
        await writeFile(inputPath, buf)
        const paths = await extractAudioSegments(inputPath, workDir)
        return blocksToUnits(segmentsToBlocks(await transcribeFiles(transcriber, paths)))
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}

export function createVideoParser(transcriber: TranscriptionClient): Parser {
  return {
    sourceType: 'video',
    async parse(buf, meta) {
      checkSize(buf, 'video')
      const workDir = await mkdtemp(join(tmpdir(), 'echo-video-'))
      try {
        const videoPath = join(workDir, `video-${meta.docId}${extOf(meta.fileName)}`)
        await writeFile(videoPath, buf)
        const paths = await extractAudioSegments(videoPath, workDir)
        const segments = await transcribeFiles(transcriber, paths)
        return blocksToUnits(segmentsToBlocks(segments))
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}

const defaultTranscriber = createTranscriptionClient()
export const audioParser: Parser = createAudioParser(defaultTranscriber)
export const videoParser: Parser = createVideoParser(defaultTranscriber)

export function mediaParserFor(fileName: string, transcriber?: TranscriptionClient): Parser | null {
  const ext = extOf(fileName)
  if (audioExtensions.has(ext)) return transcriber ? createAudioParser(transcriber) : audioParser
  if (videoExtensions.has(ext)) return transcriber ? createVideoParser(transcriber) : videoParser
  return null
}

export async function estimateDuration(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', path
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (data: Buffer) => (out += data.toString()))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const seconds = Number(out.trim())
      resolve(Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : null)
    })
  })
}
