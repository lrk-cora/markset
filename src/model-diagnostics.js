// Allowlisted, view-only transport metadata. Never retain prompts, output,
// screenshots, secrets or arbitrary provider error messages.
export function modelTimeoutMetadata(value = {}) {
  const source = value?.timeoutSource, stage = value?.timeoutStage
  if (!(source === 'local' && ['connect','first-output','idle','total'].includes(stage)
    || source === 'upstream' && stage === 'provider')) return {}
  return { timeoutSource: source, timeoutStage: stage,
    ...(typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
      ? { timeoutMs: Math.min(180_000, Math.round(value.timeoutMs)) } : {}) }
}

export function sanitizeModelAttempts(value) {
  if (!Array.isArray(value)) return []
  return value.slice(-12).filter(item => item && typeof item === 'object').map(item => {
    const result = { ...modelTimeoutMetadata(item) }
    for (const key of ['request','attempt','elapsedMs','headersMs','firstOutputMs','lastProgressMs']) {
      if (typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] >= 0) result[key] = Math.min(180_000, Math.round(item[key]))
    }
    for (const key of ['succeeded','aborted']) if (typeof item[key] === 'boolean') result[key] = item[key]
    if (Number.isInteger(item.status) && item.status >= 100 && item.status <= 599) result.status = item.status
    if (/^model_[a-z_]{1,64}$/u.test(item.code || '')) result.code = item.code
    return result
  })
}

export function modelTimeoutDescription(value) {
  const metadata = modelTimeoutMetadata(value)
  return metadata.timeoutSource === 'upstream' ? '上游接口返回 504'
    : ({ connect:'本地连接 / 响应头等待超时', 'first-output':'本地首次有效输出等待超时',
      idle:'本地流式输出停滞超时', total:'后端规划全流程总时限' })[metadata.timeoutStage] || ''
}
