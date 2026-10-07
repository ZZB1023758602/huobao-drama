/**
 * WalkingwithAI Studio（QuickStudio）自建 GPU 推理服务共享客户端。
 *
 * 协议（实测自服务端 /api/v1/openapi.json）：
 * - POST /api/v1/assets?asset_type=image|video|audio  multipart 上传，返回 { asset_id }
 * - POST /api/v1/jobs  { feature, mode, inputs, parameters } → { job_id, status }
 * - GET  /api/v1/jobs/{job_id}         只有进度与状态，不含产物地址
 * - GET  /api/v1/jobs/{job_id}/outputs 产物列表，取 relativePath
 * - GET  /api/v1/outputs/download?relativePath=...  下载字节
 *
 * 因此参考素材必须是上传后的 asset_id（不能传 URL），产物必须二次请求才能拿到地址。
 * 服务默认不校验鉴权；配置里填了 api_key 时按 Bearer 透传。
 */
import fs from 'fs'
import path from 'path'
import { getAbsolutePath, parseDataUrl } from '../../utils/storage.js'
import { joinProviderUrl } from './url'
import type { AIConfig } from './types'

export const QUICKSTUDIO_PROVIDER = 'quickstudio'
export const QUICKSTUDIO_IMAGE_FEATURE = 'qwen-image-2.1'
export const QUICKSTUDIO_VIDEO_FEATURE = 'minimax-h3'

const API_PREFIX = '/api/v1'

export type QuickStudioAssetKind = 'image' | 'video' | 'audio'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'])

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
}

export function quickStudioUrl(baseUrl: string, endpoint: string): string {
  return joinProviderUrl(requireBaseUrl(baseUrl), API_PREFIX, endpoint)
}

function requireBaseUrl(baseUrl: string): string {
  const base = String(baseUrl || '').trim()
  if (!base) throw new Error('QuickStudio 配置缺少 base_url（形如 https://xxx.compshare.cn）')
  return base
}

export function quickStudioHeaders(config: AIConfig, withJson = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

export function parseStudioArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim())
  } catch {
    return []
  }
}

function assetKindFor(mimeType: string, filename: string): QuickStudioAssetKind {
  const ext = path.extname(filename).toLowerCase()
  if (mimeType.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image'
  if (mimeType.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video'
  if (mimeType.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio'
  throw new Error(`QuickStudio 不支持该参考素材格式: ${filename || mimeType}`)
}

interface StudioMedia {
  buffer: Buffer
  filename: string
  mimeType: string
}

/** 参考素材可能是 dataURL、http(s) 地址或本地 static 相对路径，统一读成字节后上传 */
async function readStudioMedia(value: string): Promise<StudioMedia> {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('参考素材地址为空')

  const dataUrl = parseDataUrl(raw)
  if (dataUrl) {
    const ext = MIME_EXT[dataUrl.mimeType] || '.png'
    return { buffer: Buffer.from(dataUrl.data, 'base64'), filename: `reference${ext}`, mimeType: dataUrl.mimeType }
  }

  if (/^https?:\/\//i.test(raw)) {
    const resp = await fetch(raw, { signal: AbortSignal.timeout(120_000) })
    if (!resp.ok) throw new Error(`下载参考素材失败: HTTP ${resp.status}`)
    const mimeType = (resp.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream'
    const tail = decodeURIComponent(raw.split('?')[0].split('/').pop() || '')
    const ext = path.extname(tail).toLowerCase() || MIME_EXT[mimeType] || ''
    return { buffer: Buffer.from(await resp.arrayBuffer()), filename: tail || `reference${ext}`, mimeType }
  }

  const filePath = getAbsolutePath(raw.replace(/^\/+/, ''))
  if (!fs.existsSync(filePath)) throw new Error(`参考素材文件不存在: ${raw}`)
  const ext = path.extname(filePath).toLowerCase()
  return {
    buffer: fs.readFileSync(filePath),
    filename: path.basename(filePath),
    mimeType: EXT_MIME[ext] || 'application/octet-stream',
  }
}

export async function uploadStudioAsset(config: AIConfig, value: string): Promise<string> {
  const media = await readStudioMedia(value)
  const kind = assetKindFor(media.mimeType, media.filename)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(media.buffer)], { type: media.mimeType }), media.filename)

  const resp = await fetch(`${quickStudioUrl(config.baseUrl, '/assets')}?asset_type=${kind}`, {
    method: 'POST',
    headers: quickStudioHeaders(config),
    body: form,
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok) throw new Error(`上传参考素材失败: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`)

  const data = await resp.json() as any
  const assetId = String(data?.asset_id || '').trim()
  if (!assetId) throw new Error('QuickStudio 上传素材后未返回 asset_id')
  return assetId
}

/** 顺序上传以保持 <Picture 1>/<Picture 2> 等参考编号与传入顺序一致 */
export async function uploadStudioAssets(config: AIConfig, values: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const value of values) ids.push(await uploadStudioAsset(config, value))
  return ids
}

export type StudioJobPhase = 'pending' | 'processing' | 'completed' | 'failed'

export function mapStudioJobStatus(status: unknown): StudioJobPhase {
  switch (String(status || '').toLowerCase()) {
    case 'queued':
    case 'pending':
      return 'pending'
    case 'running':
      return 'processing'
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'completed'
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'canceled':
    case 'interrupted':
      return 'failed'
    default:
      return 'processing'
  }
}

export function studioJobError(result: any, fallback: string): string {
  const err = result?.error
  if (typeof err === 'string' && err.trim()) return err.trim()
  if (err && typeof err === 'object') {
    const message = err.message || err.detail
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  const status = String(result?.status || '').trim()
  return status ? `${fallback}（状态: ${status}）` : fallback
}

/** 任务状态接口不含产物地址，终态时补拉 outputs 换取下载地址 */
export async function fetchStudioOutput(
  config: AIConfig,
  jobId: string,
  kind: QuickStudioAssetKind,
): Promise<{ url: string; duration?: number }> {
  const resp = await fetch(quickStudioUrl(config.baseUrl, `/jobs/${encodeURIComponent(jobId)}/outputs`), {
    headers: quickStudioHeaders(config),
    signal: AbortSignal.timeout(60_000),
  })
  if (!resp.ok) throw new Error(`查询 QuickStudio 产物失败: HTTP ${resp.status}`)

  const data = await resp.json() as any
  const outputs: any[] = Array.isArray(data?.outputs) ? data.outputs : []
  const matched = outputs.find(item => String(item?.media_type || '').startsWith(`${kind}/`)) || outputs[0]
  const relativePath = String(matched?.relativePath || '').trim()
  if (!relativePath) throw new Error('QuickStudio 任务已完成但未返回产物文件')

  const url = new URL(quickStudioUrl(config.baseUrl, '/outputs/download'))
  url.searchParams.set('relativePath', relativePath)

  const duration = Number(matched?.duration)
  return { url: url.toString(), ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}) }
}
