import { machineCause, requestFailure as fail, retryRequest, withDeadline } from './retry.js'
import { downloadGatewayImage } from './image-gateway.js'
import { routeImage } from './model-routing.js'
import { assertPublicUrl } from './safe-url.js'

const preConnect = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
const providerCode = (value) => /^[A-Za-z][A-Za-z0-9_.]{0,79}$/u.test(String(value || '')) ? String(value) : ''
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms)
  function done() { signal.removeEventListener('abort', cancel); resolve() }
  function cancel() { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason) }
  if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
})

export async function imageInput(value) {
  const image = String(value || '')
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(image)) {
    if (Buffer.byteLength(image.split(',')[1], 'base64') > 10 * 1024 * 1024) throw fail('原图超过 10MB', 'image_input_too_large', 400)
    return image
  }
  if (image.startsWith('http')) { await assertPublicUrl(image); return image }
  throw fail('图片编辑需要可读取的 PNG/JPEG/WebP 原图', 'image_missing_original', 400)
}

export async function requestBailianImage({ config, payload = {}, taskId: existingTaskId = '',
  onTask, timeoutMs = 180_000, retries = 1, signal, fetchImpl = fetch, pollMs = 1800 }) {
  const routing = routeImage(payload, config)
  const mode = payload.mode || (payload.replaceExisting ? 'edit' : 'generate')
  if (!['edit', 'generate'].includes(mode)) throw fail('图片模式无效', 'image_invalid_mode', 400)
  const prompt = String(payload.prompt || '').trim()
  if (!prompt) throw fail('请描述要生成或编辑的图片', 'missing_prompt', 400)
  if (!config.apiKey) throw fail('未配置百炼密钥', 'missing_image_key', 503)
  let taskId = existingTaskId, retriesUsed = 0
  if (taskId && !/^[\w-]{1,128}$/u.test(taskId)) throw fail('图片任务 ID 无效', 'image_invalid_task_id', 400)
  const startedAt = Date.now()
  const timeoutError = fail('图片任务等待超时；将查询原任务，不重复生成', 'image_timeout', 504, { ambiguous: true })
  async function json(url, body, requestSignal) {
    let response
    try {
      response = await fetchImpl(url, { method: body ? 'POST' : 'GET', signal: requestSignal,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
          ...(body ? { 'X-DashScope-Async': 'enable' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch (error) {
      requestSignal.throwIfAborted()
      throw fail('百炼图片接口连接中断', 'image_gateway_unreachable', 502,
        { safeToRetry: preConnect.has(machineCause(error)), ambiguous: Boolean(body), transient: true })
    }
    let data
    try { data = await response.json() } catch {
      requestSignal.throwIfAborted()
      throw fail('百炼图片接口返回格式异常', 'image_invalid_response', 502, { ambiguous: Boolean(body) })
    }
    if (!response.ok || data.code) {
      const status = response.ok ? 400 : response.status
      throw fail([401,403].includes(status) ? '百炼图片鉴权失败' : status === 429 ? '百炼图片额度受限或繁忙' : '百炼图片请求失败',
        [401,403].includes(status) ? 'image_gateway_auth' : status < 500 ? 'image_gateway_request' : 'image_gateway_upstream', status,
        { providerCode: providerCode(data.code), transient: [502,503,504].includes(status), ambiguous: Boolean(body) && status >= 500 })
    }
    return data
  }
  try {
    return await withDeadline(async (jobSignal) => {
      if (!taskId) {
        // An editing job MUST contain its original, not a screenshot of the page.
        const original = mode === 'edit' ? await imageInput(payload.imageDataUrl) : null
        jobSignal.throwIfAborted()
        const ratio = Number(payload.width) / Number(payload.height)
        const size = ratio >= 1.45 ? '1536*1024' : ratio <= 0.7 ? '1024*1536' : '1024*1024'
        const content = [...(original ? [{ image: original }] : []), { text: prompt }]
        const data = await retryRequest((s) => json(`${config.origin}/api/v1/services/aigc/image-generation/generation`, {
          model: routing.model, input: { messages: [{ role: 'user', content }] },
          parameters: { n: 1, size, prompt_extend: true, prompt_extend_mode: 'direct', watermark: false },
        }, s), { retries: Math.min(1,retries), timeoutMs, signal: jobSignal, timeoutError,
          onRetry: () => { retriesUsed++ }, canRetry: (error) => error.safeToRetry === true })
        taskId = data.output?.task_id || ''
        if (!/^[\w-]{1,128}$/u.test(taskId)) throw fail('百炼未返回任务 ID；未重复提交', 'image_invalid_response', 502, { ambiguous: true })
        // Persist BEFORE querying/downloading, so recovery never creates a new job.
        onTask?.({ taskId, model: routing.model, mode, region: config.region })
      }
      for (;;) {
        jobSignal.throwIfAborted()
        const data = await retryRequest((s) => json(`${config.origin}/api/v1/tasks/${taskId}`, null, s), {
          retries: Math.max(0, Math.min(1,retries) - retriesUsed), timeoutMs, attemptTimeoutMs: 20_000,
          signal: jobSignal, timeoutError, canRetry: (error) => error.transient || error.code === 'image_timeout',
          onRetry: () => { retriesUsed++ },
        })
        const status = data.output?.task_status
        if (status === 'SUCCEEDED') {
          const url = data.output?.choices?.flatMap((choice) => choice.message?.content || []).find((part) => part.image)?.image
          if (!url) throw fail('图片任务成功但没有返回图片', 'image_empty_response', 502)
          await assertPublicUrl(url)
          const imageUrl = await downloadGatewayImage(url, { signal: jobSignal, fetchImpl,
            retries: Math.max(0, Math.min(1,retries) - retriesUsed), onRetry: () => { retriesUsed++ } })
          return { imageUrl, taskId, model: routing.model, routing, mode, region: config.region,
            elapsedMs: Date.now() - startedAt, retriesUsed, usage: data.usage || null }
        }
        if (['FAILED','CANCELED'].includes(status)) throw fail('百炼图片任务未完成，未重复生成', 'image_task_failed', 502, { providerCode: providerCode(data.output?.code) })
        if (!['PENDING','RUNNING'].includes(status)) throw fail('图片任务状态未知；未重新生成', 'image_task_unknown', 502, { ambiguous: true })
        await pause(pollMs, jobSignal)
      }
    }, { timeoutMs, signal, timeoutError })
  } catch (error) { if (taskId) error.taskId = taskId; throw error }
}
