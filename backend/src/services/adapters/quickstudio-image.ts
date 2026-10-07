/**
 * QuickStudio 图片生成 Adapter（feature: qwen-image-2.1）
 * 无参考图走 t2i，有参考图走 i2i；参考图必须先上传为 asset_id。
 */
import type {
  AIConfig,
  ImageGenResponse,
  ImageGenerationRecord,
  ImagePollResponse,
  ImageProviderAdapter,
  PollContext,
  ProviderRequest,
} from './types'
import {
  QUICKSTUDIO_IMAGE_FEATURE,
  QUICKSTUDIO_PROVIDER,
  fetchStudioOutput,
  mapStudioJobStatus,
  parseStudioArray,
  quickStudioHeaders,
  quickStudioUrl,
  studioJobError,
  uploadStudioAssets,
} from './quickstudio'

export class QuickStudioImageAdapter implements ImageProviderAdapter {
  provider = QUICKSTUDIO_PROVIDER
  uploadsReferenceMedia = true

  async buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): Promise<ProviderRequest> {
    const prompt = String(record.prompt || '').trim()
    if (!prompt) throw new Error('QuickStudio 图片生成要求 prompt 非空')

    const referenceImages = await uploadStudioAssets(config, parseStudioArray(record.referenceImages))
    const inputs: Record<string, unknown> = { prompt }
    if (referenceImages.length) inputs.reference_images = referenceImages.slice(0, 10)

    const parameters: Record<string, unknown> = {
      // 火宝的提示词由分镜流水线拼装（含风格预设与负面词），再让服务端改写会破坏角色一致性
      optimize_prompt: false,
    }
    const size = parseImageSize(record.size)
    if (size) {
      parameters.width = size.width
      parameters.height = size.height
      // i2i 不遵循 width/height：产物画幅跟随首张参考图，尺寸由 reference_resolution
      // （约方图像素面积）决定，故把项目请求的 WxH 折算为等效边长传过去。
      if (referenceImages.length) {
        parameters.reference_resolution = snapToMultiple(Math.sqrt(size.width * size.height))
      }
    }

    return {
      url: quickStudioUrl(config.baseUrl, '/jobs'),
      method: 'POST',
      headers: quickStudioHeaders(config, true),
      body: {
        feature: QUICKSTUDIO_IMAGE_FEATURE,
        mode: referenceImages.length ? 'i2i' : 't2i',
        title: `火宝短剧·图片#${record.id}`,
        inputs,
        parameters,
      },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const jobId = String(result?.job_id || '').trim()
    if (jobId) return { isAsync: true, taskId: jobId }
    throw new Error('QuickStudio 响应中缺少 job_id')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: quickStudioUrl(config.baseUrl, `/jobs/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: quickStudioHeaders(config),
      body: undefined,
    }
  }

  async parsePollResponse(result: any, context?: PollContext): Promise<ImagePollResponse> {
    const phase = mapStudioJobStatus(result?.status)
    if (phase === 'failed') {
      return { status: 'failed', error: studioJobError(result, 'QuickStudio 图片生成失败') }
    }
    if (phase !== 'completed') return { status: phase }
    if (!context) return { status: 'failed', error: 'QuickStudio 轮询缺少上下文，无法查询产物' }

    const { url } = await fetchStudioOutput(context.config, context.taskId, 'image')
    return { status: 'completed', imageUrl: url }
  }

  extractImageUrl(_result: any): string | null {
    // 产物地址在 /jobs/{id}/outputs，由 parsePollResponse 补拉，响应本身不含 URL
    return null
  }

  extractImageBase64(_result: any): { data: string; mimeType: string } | null {
    return null
  }
}

/** QuickStudio 的 width/height 需为 32 的倍数、256~4096 */
function parseImageSize(size?: string | null): { width: number; height: number } | null {
  const matched = String(size || '').trim().match(/^(\d+)\s*[x×*]\s*(\d+)$/i)
  if (!matched) return null
  const width = snapToMultiple(Number(matched[1]))
  const height = snapToMultiple(Number(matched[2]))
  if (!width || !height) return null
  return { width, height }
}

function snapToMultiple(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  const snapped = Math.round(value / 32) * 32
  return Math.min(4096, Math.max(256, snapped))
}
