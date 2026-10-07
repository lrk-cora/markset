export function requestFailure(message, code, status, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra })
}

export function machineCause(error) {
  const code = error?.cause?.code || error?.code || ''
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : ''
}

const TRANSIENT_TRANSPORT_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])
export function transientTransport(error) { return TRANSIENT_TRANSPORT_CODES.has(machineCause(error)) }

export function retryAfterMs(response) {
  const value = response.headers?.get('retry-after')
  if (!value) return 0
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - Date.now()) || 0
}

export async function withDeadline(task, { timeoutMs, signal, timeoutError }) {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(signal.reason)
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(controller.signal.reason)
  controller.signal.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onParentAbort()
  else signal?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  try {
    return await Promise.race([
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return task(controller.signal) }),
      aborted,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

async function pause(milliseconds, signal) {
  signal.throwIfAborted()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    function done() { signal.removeEventListener('abort', cancel); resolve() }
    function cancel() { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/** One bounded retry loop, including full body reads and backoff. */
export function retryRequest(task, {
  retries = 0, timeoutMs, attemptTimeoutMs = timeoutMs, signal, timeoutError,
  canRetry = () => false, baseDelayMs = 400, onRetry,
}) {
  const limit = Math.max(0, Math.min(2, Math.trunc(Number(retries)) || 0))
  return withDeadline(async (totalSignal) => {
    const startedAt = Date.now()
    for (let attempt = 0; attempt <= limit; attempt++) {
      totalSignal.throwIfAborted()
      const remaining = timeoutMs - (Date.now() - startedAt)
      if (remaining <= 0) throw timeoutError
      try {
        return await withDeadline((attemptSignal) => task(attemptSignal, attempt), {
          timeoutMs: Math.min(attemptTimeoutMs, remaining), signal: totalSignal, timeoutError,
        })
      } catch (error) {
        totalSignal.throwIfAborted()
        if (attempt >= limit || !canRetry(error)) throw error
        const delay = Math.max(baseDelayMs * 2 ** attempt, error.retryAfterMs || 0)
        // Respect Retry-After rather than shortening a provider's cooldown.
        if (delay >= timeoutMs - (Date.now() - startedAt)) throw error
        onRetry?.({ attempt: attempt + 1, error, delayMs: delay })
        await pause(delay, totalSignal)
      }
    }
  }, { timeoutMs, signal, timeoutError })
}
