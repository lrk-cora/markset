import { requestFailure } from './retry.js'

/** First useful output and stream inactivity are separate from the hard total
 * deadline owned by retryRequest/the planner. Headers and SSE heartbeats do not
 * buy extra time. Only public content or native tool arguments count as progress.
 * Race cancellation too: adapters that ignore AbortSignal must not hang callers. */
export async function withModelProgressDeadline(task, { signal, firstOutputTimeoutMs, idleTimeoutMs }) {
  const controller = new AbortController()
  let timer, stage = 'connect'
  const arm = (timeoutMs) => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(requestFailure(
      stage === 'idle' ? 'AI 输出中断等待超时' : '等待 AI 首次输出超时',
      stage === 'idle' ? 'model_stream_idle_timeout' : 'model_first_output_timeout', 504,
      { timeoutSource: 'local', timeoutStage: stage, timeoutMs },
    )), timeoutMs)
  }
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(controller.signal.reason)
  const onParentAbort = () => controller.abort(signal.reason)
  controller.signal.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onParentAbort()
  else signal?.addEventListener('abort', onParentAbort, { once: true })
  arm(firstOutputTimeoutMs)
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return task({
          signal: controller.signal,
          headersReceived() { if (stage === 'connect') stage = 'first-output' },
          progress() {
            controller.signal.throwIfAborted()
            stage = 'idle'; arm(idleTimeoutMs)
          },
        })
      }),
      aborted,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
