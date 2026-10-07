import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QuickStudioImageAdapter } from '../src/services/adapters/quickstudio-image'
import { QuickStudioVideoAdapter } from '../src/services/adapters/quickstudio-video'

const config = {
  provider: 'quickstudio',
  baseUrl: 'https://7860-demo.pod.compshare.cn',
  apiKey: '',
  model: '',
}

const imageAdapter = new QuickStudioImageAdapter()
const videoAdapter = new QuickStudioVideoAdapter()

test('QuickStudio image adapter submits t2i jobs with custom size snapped to 32px', async () => {
  const request = await imageAdapter.buildGenerateRequest(config, {
    id: 7,
    prompt: '雨夜街角的便利店',
    size: '1920x1080',
  })

  assert.equal(request.url, 'https://7860-demo.pod.compshare.cn/api/v1/jobs')
  assert.equal(request.method, 'POST')
  assert.deepEqual(request.body, {
    feature: 'qwen-image-2.1',
    mode: 't2i',
    title: '火宝短剧·图片#7',
    inputs: { prompt: '雨夜街角的便利店' },
    parameters: { optimize_prompt: false, width: 1920, height: 1088 },
  })
})

test('QuickStudio image adapter rejects empty prompts before uploading references', async () => {
  await assert.rejects(
    () => imageAdapter.buildGenerateRequest(config, { id: 1, prompt: '  ' }),
    /prompt 非空/,
  )
})

test('QuickStudio poll maps queue states and surfaces terminal errors', async () => {
  assert.deepEqual(await imageAdapter.parsePollResponse({ status: 'queued' }), { status: 'pending' })
  assert.deepEqual(await videoAdapter.parsePollResponse({ status: 'running', progress: 25 }), { status: 'processing' })
  assert.deepEqual(
    await videoAdapter.parsePollResponse({ status: 'cancelled', error: 'CUDA out of memory' }),
    { status: 'failed', error: 'CUDA out of memory' },
  )
  assert.deepEqual(
    (await imageAdapter.parsePollResponse({ status: 'failed', error: { message: 'ComfyUI 中断' } })).error,
    'ComfyUI 中断',
  )
})

test('QuickStudio adapters require a job_id in the submit response', () => {
  assert.throws(() => imageAdapter.parseGenerateResponse({ detail: 'bad request' }), /缺少 job_id/)
  assert.deepEqual(videoAdapter.parseGenerateResponse({ job_id: 'abc' }), { isAsync: true, taskId: 'abc' })
})

test('QuickStudio video adapter submits t2v with preset tiers instead of raw pixels', async () => {
  const request = await videoAdapter.buildGenerateRequest(config, {
    id: 12,
    prompt: '镜头缓慢推进',
    aspectRatio: '9:16',
    resolution: '720p',
    duration: 99,
    seed: -1,
  })

  assert.equal(request.body.feature, 'minimax-h3')
  assert.equal(request.body.mode, 't2v')
  assert.deepEqual(request.body.parameters, {
    resolution_preset: '768P',
    aspect_ratio: '9:16',
    duration: 15,
    seed: -1,
  })
})

test('QuickStudio video adapter maps 1080p to the 1K preset and drops unknown ratios', async () => {
  const request = await videoAdapter.buildGenerateRequest(config, {
    id: 13,
    prompt: '空镜',
    aspectRatio: 'adaptive',
    resolution: '1080p',
  })

  assert.deepEqual(request.body.parameters, { resolution_preset: '1K' })
})

test('QuickStudio video adapter fails fast when only a last frame or audio is present', async () => {
  await assert.rejects(
    () => videoAdapter.buildGenerateRequest(config, { id: 14, prompt: 'x', lastFrameUrl: 'static/images/a.png' }),
    /需要首帧参考图/,
  )
  await assert.rejects(
    () => videoAdapter.buildGenerateRequest(config, {
      id: 15,
      prompt: 'x',
      referenceAudioUrls: JSON.stringify(['static/audio/a.mp3']),
    }),
    /需要首帧参考图/,
  )
})
