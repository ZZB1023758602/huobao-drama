/**
 * QuickStudio 视频生成 Adapter（feature: minimax-h3）
 *
 * 模式按素材自动选择：
 * - 有参考图/参考视频 → r2v（全能参考）
 * - 有首帧或尾帧 → i2v（首尾帧；带驱动音频时开启 audio_drive）
 * - 仅提示词 → t2v
 */
import type {
  AIConfig,
  PollContext,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import {
  QUICKSTUDIO_PROVIDER,
  QUICKSTUDIO_VIDEO_FEATURE,
  fetchStudioOutput,
  mapStudioJobStatus,
  parseStudioArray,
  quickStudioHeaders,
  quickStudioUrl,
  studioJobError,
  uploadStudioAsset,
  uploadStudioAssets,
} from './quickstudio'

const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'])
const MIN_DURATION = 2
const MAX_DURATION = 15

export class QuickStudioVideoAdapter implements VideoProviderAdapter {
  provider = QUICKSTUDIO_PROVIDER
  uploadsReferenceMedia = true

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const prompt = String(record.prompt || '').trim()
    const rawImages = parseStudioArray(record.referenceImageUrls)
    const rawVideos = parseStudioArray(record.referenceVideoUrls)
    const rawAudios = parseStudioArray(record.referenceAudioUrls)
    const rawFirstFrame = String(record.firstFrameUrl || record.imageUrl || '').trim()
    const rawLastFrame = String(record.lastFrameUrl || '').trim()

    // 先校验再上传：素材上传要占 GPU 服务器的输入目录，失败时不该留下半成品
    if (!rawFirstFrame && (rawLastFrame || rawAudios.length)) {
      throw new Error('QuickStudio 图生视频需要首帧参考图，请为该分镜生成首帧或改用文生视频')
    }
    if (!prompt && !rawImages.length && !rawVideos.length && !rawFirstFrame) {
      throw new Error('QuickStudio 视频生成需要提示词或至少一个参考素材')
    }

    const referenceImages = await uploadStudioAssets(config, rawImages)
    const referenceVideos = await uploadStudioAssets(config, rawVideos)
    const referenceAudios = await uploadStudioAssets(config, rawAudios)
    const firstFrame = rawFirstFrame ? await uploadStudioAsset(config, rawFirstFrame) : null
    const lastFrame = rawLastFrame ? await uploadStudioAsset(config, rawLastFrame) : null

    const inputs: Record<string, unknown> = { prompt }
    const parameters: Record<string, unknown> = {}
    let mode = 't2v'

    if (referenceImages.length || referenceVideos.length) {
      mode = 'r2v'
      if (referenceImages.length) inputs.reference_images = referenceImages.slice(0, 9)
      if (referenceVideos.length) inputs.reference_videos = referenceVideos.slice(0, 3)
      if (referenceAudios.length) inputs.reference_audios = referenceAudios.slice(0, 3)
    } else if (firstFrame) {
      mode = 'i2v'
      inputs.first_frame = firstFrame
      if (lastFrame) inputs.last_frame = lastFrame
      if (referenceAudios.length) {
        inputs.driving_audio = referenceAudios[0]
        parameters.audio_drive_enabled = true
      }
    }

    const resolutionPreset = mapResolution(record.resolution)
    if (resolutionPreset) parameters.resolution_preset = resolutionPreset
    // 首帧模式由图片决定画幅，强行传比例会与构图冲突
    if (!firstFrame) {
      const aspectRatio = mapAspectRatio(record.aspectRatio)
      if (aspectRatio) parameters.aspect_ratio = aspectRatio
    }
    if (!parameters.audio_drive_enabled) {
      const duration = mapDuration(record.duration)
      if (duration) parameters.duration = duration
    }
    if (record.seed !== null && record.seed !== undefined) parameters.seed = record.seed

    return {
      url: quickStudioUrl(config.baseUrl, '/jobs'),
      method: 'POST',
      headers: quickStudioHeaders(config, true),
      body: {
        feature: QUICKSTUDIO_VIDEO_FEATURE,
        mode,
        title: `火宝短剧·分镜#${record.id}`,
        inputs,
        parameters,
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const jobId = String(result?.job_id || '').trim()
    if (jobId) return { isAsync: true, taskId: jobId }
    throw new Error(`QuickStudio 响应中缺少 job_id：${studioJobError(result, '任务提交失败')}`)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: quickStudioUrl(config.baseUrl, `/jobs/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: quickStudioHeaders(config),
      body: undefined,
    }
  }

  async parsePollResponse(result: any, context?: PollContext): Promise<VideoPollResponse> {
    const phase = mapStudioJobStatus(result?.status)
    if (phase === 'failed') {
      return { status: 'failed', error: studioJobError(result, 'QuickStudio 视频生成失败') }
    }
    if (phase !== 'completed') return { status: phase }
    if (!context) return { status: 'failed', error: 'QuickStudio 轮询缺少上下文，无法查询产物' }

    const output = await fetchStudioOutput(context.config, context.taskId, 'video')
    return { status: 'completed', videoUrl: output.url, ...(output.duration ? { duration: output.duration } : {}) }
  }

  extractVideoUrl(_result: any): string | null {
    // 产物地址在 /jobs/{id}/outputs，由 parsePollResponse 补拉
    return null
  }
}

/** 项目内 480p/720p/1080p/2K → Studio 档位；2K 服务端已下线，落到 1K */function mapResolution(resolution?: string | null): string | null {
  switch (String(resolution || '').trim().toLowerCase()) {
    case '480p': return '480P'
    case '720p': return '768P'
    case '1080p':
    case '2k': return '1K'
    default: return null
  }
}

function mapAspectRatio(aspectRatio?: string | null): string | null {
  const value = String(aspectRatio || '').trim()
  return ASPECT_RATIOS.has(value) ? value : null
}

function mapDuration(duration?: number | null): number | null {
  const value = Number(duration)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(value)))
}
