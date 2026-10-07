import { randomUUID } from 'node:crypto'
import { machineCause, requestFailure as failure, retryAfterMs, retryRequest, withDeadline, transientTransport } from './retry.js'

const PRE_CONNECT_FAILURES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

function dataImage(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw failure('生成图片为空或超过大小限制', 'image_invalid_response', 502)
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
        : /^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6)) ? 'image/gif' : ''
  if (!mime) throw failure('图片服务返回了无效图片', 'image_invalid_response', 502)
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function discard(response) { try { await response.body?.cancel() } catch {} }

function statusError(response) {
  const status = response.status
  const extra = { upstreamStatus: status, retryAfterMs: retryAfterMs(response) }
  if (status === 401 || status === 403) return failure('图片服务鉴权失败，请检查服务端密钥', 'image_gateway_auth', status, extra)
  if (status === 429) return failure('图片服务繁忙或额度受限，请稍后重试', 'image_gateway_rate_limit', 429, extra)
  if (status >= 400 && status < 500) return failure('图片请求被拒绝，请检查图片模型和参数', 'image_gateway_request', status, extra)
  if (status === 504) return failure('图片生成超时，请稍后检查结果', 'image_timeout', 504, extra)
  return failure('图片生成网关响应异常', 'image_gateway_upstream', 502, extra)
}

/** Retrying an existing result's GET never submits another paid generation. */
export async function downloadGatewayImage(url, {
  signal, retries = 1, timeoutMs = 30_000, attemptTimeoutMs = 15_000,
  onRetry, baseDelayMs = 400, fetchImpl = fetch,
} = {}) {
  if (!/^https?:\/\//iu.test(url)) throw failure('图片结果地址无效', 'image_invalid_response', 502)
  const timeoutError = failure('生成结果的图片下载超时', 'image_download_timeout', 504)
  return retryRequest(async (attemptSignal) => {
    let response
    try { response = await fetchImpl(url, { signal: attemptSignal }) } catch (error) {
      attemptSignal.throwIfAborted()
      throw failure('生成结果的图片下载失败', 'image_download_failed', 502, { causeCode: machineCause(error), transient: transientTransport(error) })
    }
    if (attemptSignal.aborted) { void discard(response); attemptSignal.throwIfAborted() }
    if (!response.ok) {
      const error = failure('生成结果的图片下载失败', 'image_download_failed', 502, {
        upstreamStatus: response.status, retryAfterMs: retryAfterMs(response), transient: [502, 503, 504].includes(response.status),
      })
      await discard(response)
      throw error
    }
    try {
      const bytes = Buffer.from(await response.arrayBuffer())
      attemptSignal.throwIfAborted()
      return dataImage(bytes)
    } catch (error) {
      attemptSignal.throwIfAborted()
      if (error.code === 'image_invalid_response') throw error
      throw failure('生成结果的图片读取失败', 'image_download_failed', 502, { transient: true })
    }
  }, { retries: Math.min(1, retries), timeoutMs, attemptTimeoutMs, signal, timeoutError, onRetry, baseDelayMs,
    canRetry: (error) => error.code === 'image_download_timeout' || Boolean(error.transient),
  })
}

export function requestGatewayImage({
  baseUrl, apiKey, model, prompt, size, quality = 'medium', requestId = randomUUID(),
  providerIdempotency = false, timeoutMs = 120_000, signal, retries = 1,
  baseDelayMs = 400, fetchImpl = fetch, deadlineError,
}) {
  if (!apiKey) return Promise.reject(failure('尚未配置图片服务密钥', 'missing_image_key', 503))
  const timeoutError = deadlineError || failure('图片生成超时，结果尚未确认；未重复提交生成任务', 'image_timeout', 504, { ambiguous: true })
  timeoutError.ambiguous = true
  timeoutError.message = '图片生成超时，结果尚未确认；未重复提交生成任务'
  let retriesUsed = 0
  return withDeadline(async (jobSignal) => {
    const data = await retryRequest(async (attemptSignal) => {
      let response
      try {
        response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
          method: 'POST', signal: attemptSignal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
          body: JSON.stringify({ model, prompt, size, quality, n: 1 }),
        })
      } catch (error) {
        attemptSignal.throwIfAborted()
        const causeCode = machineCause(error)
        const safeToRetry = PRE_CONNECT_FAILURES.has(causeCode)
        throw failure(safeToRetry ? '图片服务连接失败' : '图片请求中断，结果尚未确认；未重复提交生成任务', 'image_gateway_unreachable', 502, { causeCode, safeToRetry, ambiguous: !safeToRetry })
      }
      if (attemptSignal.aborted) { void discard(response); attemptSignal.throwIfAborted() }
      if (!response.ok) {
        const error = statusError(response)
        error.ambiguous = [502, 503, 504].includes(response.status)
        if (error.ambiguous && !providerIdempotency) error.message += '；结果尚未确认，未重复提交生成任务'
        await discard(response)
        throw error
      }
      let result
      try { result = await response.json() } catch {
        attemptSignal.throwIfAborted()
        throw failure('图片服务返回格式异常，未重复提交生成任务', 'image_invalid_response', 502)
      }
      attemptSignal.throwIfAborted()
      return result
    }, {
      retries: Math.min(1, retries), timeoutMs,
      attemptTimeoutMs: providerIdempotency ? Math.min(60_000, timeoutMs / 2) : timeoutMs,
      signal: jobSignal, timeoutError, baseDelayMs,
      onRetry: () => { retriesUsed++ },
      canRetry: (error) => error.safeToRetry || providerIdempotency && (
        error.code === 'image_timeout' || error.code === 'image_gateway_unreachable'
        || error.code === 'image_gateway_upstream' && [502, 503, 504].includes(error.upstreamStatus)
      ),
    })
    const result = data?.data?.[0] || data?.output?.[0] || {}
    let imageUrl
    if (typeof result.b64_json === 'string' && result.b64_json) {
      if (result.b64_json.length > MAX_IMAGE_BYTES * 1.4) throw failure('生成图片超过大小限制', 'image_invalid_response', 502)
      imageUrl = dataImage(Buffer.from(result.b64_json, 'base64'))
    } else {
      const url = result.url || result.image_url || ''
      if (!url) throw failure('图片服务没有返回图片，未重复提交生成任务', 'image_empty_response', 502)
      // Generation is now known to have succeeded. A later deadline must not
      // imply that another generation POST might be needed.
      timeoutError.message = '图片已生成，但结果下载超时；未重新生成图片'
      timeoutError.code = 'image_download_timeout'
      timeoutError.ambiguous = false
      imageUrl = await downloadGatewayImage(url, {
        signal: jobSignal, fetchImpl, baseDelayMs,
        retries: Math.max(0, Math.min(1, retries) - retriesUsed),
        onRetry: () => { retriesUsed++ },
      })
    }
    jobSignal.throwIfAborted()
    return { imageUrl, model, requestId, retriesUsed }
  }, { timeoutMs, signal, timeoutError })
}
