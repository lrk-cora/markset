import { machineCause, requestFailure as failure, retryAfterMs, retryRequest, transientTransport } from './retry.js'
import { readModelStream } from './model-stream.js'
import { withModelProgressDeadline } from './model-deadline.js'
import { modelTimeoutMetadata } from '../src/model-diagnostics.js'

async function discard(response) { try { await response.body?.cancel() } catch {} }

// Keep one hard deadline across all retries, but never restart a healthy stream
// merely because its total duration exceeds the first-output wait allowance.
export async function requestModelChat({ baseUrl, apiKey, model, messages, temperature = 0,
  maxTokens = 1200, retries = 2, timeoutMs = 60_000, attemptTimeoutMs = 30_000,
  firstOutputTimeoutMs = attemptTimeoutMs, idleTimeoutMs = 15_000,
  signal, onRetry, requestOptions = {}, onResponse, onAttempt, onDelta, onStart, stream = false, returnMessage = false, baseDelayMs = 400, fetchImpl = fetch }) {
  if (!apiKey) throw failure('尚未配置 AI 服务密钥', 'missing_model_key', 503)
  const timeoutError = failure('AI 请求达到总时限', 'model_total_timeout', 504,
    { timeoutSource: 'local', timeoutStage: 'total', timeoutMs })
  const run = (parentSignal, attempt) => withModelProgressDeadline(async ({ signal: attemptSignal, headersReceived, progress }) => {
    let response, headersMs = null, firstOutputMs = null, lastProgressMs = null, succeeded = false, recorded = false, attemptError
    const startedAt = Date.now()
    const record = () => {
      if (recorded) return
      recorded = true
      const error = attemptSignal.aborted ? attemptSignal.reason : attemptError
      onAttempt?.({ attempt: attempt + 1, elapsedMs: Date.now() - startedAt, headersMs, firstOutputMs, lastProgressMs, succeeded,
        status: response?.status || null, aborted: attemptSignal.aborted,
        code: typeof error?.code === 'string' ? error.code : '', ...modelTimeoutMetadata(error) })
    }
    attemptSignal.addEventListener('abort', record, { once: true })
    try {
      attemptSignal.throwIfAborted()
      onStart?.({ attempt: attempt + 1 })
      try {
        response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', signal: attemptSignal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...requestOptions, model, temperature, max_tokens: maxTokens, messages,
            ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) }),
        })
      } catch (error) {
        attemptSignal.throwIfAborted()
        throw failure('无法连接 AI 网关', 'model_gateway_unreachable', 502, { causeCode: machineCause(error), transient: transientTransport(error) })
      }
      headersMs = Date.now() - startedAt
      if (attemptSignal.aborted) { void discard(response); attemptSignal.throwIfAborted() }
      headersReceived()
      const status = response.status
      if (!response.ok) {
        // Don't deserialize an arbitrary gateway error page or reflect it to the
        // browser. A 502 HTML body is still an upstream failure, not invalid JSON.
        await discard(response)
        if (status === 401 || status === 403) throw failure('AI 网关鉴权失败', 'model_gateway_auth', status, { upstreamStatus: status })
        if (status === 429) throw failure('AI 网关繁忙或额度受限', 'model_gateway_rate_limit', 429, { upstreamStatus: status, retryAfterMs: retryAfterMs(response) })
        if (status === 504) throw failure('AI 网关响应超时', 'model_gateway_timeout', 504, { upstreamStatus: status, retryAfterMs: retryAfterMs(response), timeoutSource: 'upstream', timeoutStage: 'provider' })
        if (status >= 400 && status < 500) throw failure('AI 请求被网关拒绝', 'model_gateway_request', status, { upstreamStatus: status })
        throw failure('AI 网关返回异常状态', 'model_gateway_upstream', 502, { upstreamStatus: status, retryAfterMs: retryAfterMs(response) })
      }
      let data
      try { data = response.headers?.get('content-type')?.includes('text/event-stream')
        ? await readModelStream(response, { signal: attemptSignal, onDelta, onProgress: () => {
          progress(); lastProgressMs = Date.now() - startedAt; firstOutputMs ??= lastProgressMs
        } }) : await response.json() } catch (error) {
        attemptSignal.throwIfAborted()
        if (error.code) throw error
        throw failure('AI 网关返回格式异常', 'model_gateway_invalid_response', 502)
      }
      attemptSignal.throwIfAborted()
      const content = data?.choices?.[0]?.message?.content
      const text = Array.isArray(content)
        ? content.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('')
        : typeof content === 'string' ? content : ''
      const toolCalls = data?.choices?.[0]?.message?.tool_calls
      if (!text.trim() && !(returnMessage && Array.isArray(toolCalls) && toolCalls.length)) throw failure('AI 网关返回了空结果', 'model_gateway_empty', 502)
      // A non-streaming provider can only expose first output after parsing its
      // body; headers alone never extend the wait for that complete JSON body.
      firstOutputMs ??= Date.now() - startedAt
      lastProgressMs ??= firstOutputMs
      onResponse?.({ model, usage: data.usage || null, providerRequestId: data.id || response.headers.get('x-request-id') || '' })
      succeeded = true
      return returnMessage ? { role:'assistant', content: text.trim() || null, ...(toolCalls?.length ? { tool_calls: toolCalls } : {}) } : text.trim()
    } catch (error) {
      attemptError = error
      throw error
    } finally {
      record()
      attemptSignal.removeEventListener('abort', record)
    }
  }, { signal: parentSignal, firstOutputTimeoutMs, idleTimeoutMs })
  return retryRequest(run, {
    // Model-only progress watchdog governs each attempt. Image retry deadlines
    // and ambiguous image-submission protections are deliberately unchanged.
    retries, timeoutMs, attemptTimeoutMs: timeoutMs, timeoutError, signal, onRetry, baseDelayMs,
    canRetry: (error) => error.code === 'model_gateway_unreachable' && error.transient
      || error.code === 'model_gateway_timeout'
      || ['model_first_output_timeout', 'model_stream_idle_timeout'].includes(error.code)
      || error.code === 'model_gateway_upstream' && [502, 503, 504].includes(error.upstreamStatus),
  })
}
