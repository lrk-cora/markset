import { MODEL_CLIENT_TIMEOUT_MS } from './request-policy.js'

/** Bound the whole analysis, including screenshot capture and response-body reads.
 * Aborting fetch alone cannot release an await on a hung image/font capture. */
export async function runAnalysisTask(task, { signal, timeoutMs = MODEL_CLIENT_TIMEOUT_MS, timeoutPhase = 'analysis' } = {}) {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(signal.reason)
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  if (signal?.aborted) onParentAbort()
  else signal?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(Object.assign(
    new DOMException('分析超时，已保留笔迹和本地方案', 'TimeoutError'),
    { timeoutPhase: ['capture','verify','analysis'].includes(timeoutPhase) ? timeoutPhase : 'analysis', timeoutMs },
  )), timeoutMs)
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return task(controller.signal)
      }),
      aborted,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

/** Recovery must be independent of geometry/model code that may have failed. */
export function analysisRecoveryIntent(group) {
  const targets = group?.targets || []
  const alternatives = targets.some((target) => target.kind === 'text')
    ? ['修改颜色', '替换文字内容']
    : targets.some((target) => target.kind === 'image') ? ['替换图片'] : []
  return {
    type: 'note', operation: 'note', confidence: 0.5, targets,
    goal: '笔迹已保留，请补充修改要求',
    needsInput: false, needsClarification: false, clarificationAlreadyAnswered: false, clarifyingQuestion: '',
    suggestion: { text: '笔迹已保留，请补充修改要求', alternatives },
    hint: '这次识别未完成，可以继续画或重新提交要求。', source: 'local-fallback',
    parameters: { hasCross: false, hasRegion: false, textStrike: false, markedTextRange: false },
  }
}
