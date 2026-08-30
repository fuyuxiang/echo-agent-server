import type { Deps } from '../../types.js'
import { DIRECT_TRANSCRIPTION_MAX_BYTES, ffmpegAvailable } from '../parsers/media.js'

/** Reject media types before persisting a job that cannot possibly complete. */
export async function sourceCapabilityError(
  sourceType: string,
  deps: Pick<Deps, 'vlmClient' | 'transcriptionClient'>,
  byteSize?: number
): Promise<string | null> {
  if (sourceType === 'image' && !deps.vlmClient.configured) {
    return '图片理解服务未配置，暂不能上传图片'
  }
  if ((sourceType === 'audio' || sourceType === 'video') && !deps.transcriptionClient.configured) {
    return '音视频转写服务未配置，暂不能上传音频或视频'
  }
  const needsFfmpeg = sourceType === 'video'
    || (sourceType === 'audio' && byteSize != null && byteSize > DIRECT_TRANSCRIPTION_MAX_BYTES)
  if (needsFfmpeg && !(await ffmpegAvailable())) {
    return '服务器未安装 ffmpeg，暂不能处理视频或大音频'
  }
  return null
}
