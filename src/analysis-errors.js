// Public, bounded messages only. Never render a gateway's raw HTML/error body.
import { blockingPlanIssues, planIssueDescription, planRepairCount } from './plan-check-policy.js'
import { modelTimeoutMetadata } from './model-diagnostics.js'

export function analysisIssue(error = {}) {
  // DOMException.code is a browser enum (TimeoutError = 23, AbortError = 20),
  // not an HTTP status. Only actual HTTP-range values may appear as statuses.
  const httpStatus = value => /^\d{3}$/u.test(String(value ?? '')) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : 0
  const status = httpStatus(error.status) || httpStatus(error.code)
  const isDeadline = error.name === 'TimeoutError'
  const timeoutPhase = isDeadline ? (['capture','verify'].includes(error.timeoutPhase) ? error.timeoutPhase : 'analysis') : ''
  const code = isDeadline ? ({ capture:'capture_timeout',verify:'verification_timeout',analysis:'analysis_timeout' })[timeoutPhase]
    : String(error.code || 'analysis_failed')
  const messages = {
    capture_page_changed: '网页布局在截图期间发生变化，请重新分析；笔迹和输入已保留',
    capture_timeout: '准备网页截图超时，请重试',
    verification_timeout: '方案执行检查超时，网页未改变，请重试',
    analysis_timeout: '分析超时（全流程总时限），请重试',
    model_gateway_timeout: 'AI 分析超时，请重试',
    model_first_output_timeout: '等待 AI 首次输出超时，请重试',
    model_stream_idle_timeout: 'AI 输出中断，等待后续内容超时，请重试',
    model_total_timeout: 'AI 规划达到总时限，请重试',
    model_gateway_unreachable: '无法连接 AI 服务，请稍后重试',
    model_gateway_auth: 'AI 服务鉴权失败，请检查服务端密钥',
    missing_model_key: '尚未配置 AI 服务密钥',
    calls_disabled: 'AI 调用已关闭，请检查服务端配置',
    model_gateway_rate_limit: 'AI 服务繁忙或额度受限，请稍后重试',
    model_gateway_request: 'AI 请求被拒绝，请检查模型与请求配置',
    model_gateway_upstream: 'AI 网关响应异常，请稍后重试',
    model_gateway_empty: 'AI 返回了空结果，请重试',
    model_gateway_invalid_response: 'AI 网关返回格式异常，请重试',
    model_invalid_plan: 'AI 未给出可执行方案，请重试或补充要求',
    agent_plan_invalid: '方案未通过执行检查，网页未改变',
    agent_tool_limit: '本次查证未能形成方案；笔迹和输入已保留',
  }
  let message = messages[code] || (status === 504 ? messages.model_gateway_timeout
    : status === 401 || status === 403 ? messages.model_gateway_auth
      : status === 429 ? messages.model_gateway_rate_limit
        : status >= 500 ? messages.model_gateway_upstream
          : error instanceof TypeError ? 'AI 请求未能连接，请检查网络后重试'
            : '这次分析未完成，请重试或补充要求')
  const timeout = modelTimeoutMetadata(error)
  if (timeout.timeoutSource === 'upstream') message = 'AI 上游接口返回超时，请稍后重试'
  else if (code === 'model_first_output_timeout' && timeout.timeoutStage === 'connect') message = '等待 AI 连接响应超时，请重试'
  const repairsUsed = planRepairCount(error.repairsUsed)
  if (code === 'agent_plan_invalid') {
    const failed = blockingPlanIssues(error.validation)[0] || (error.reason ? {code:error.reason} : null)
    if (failed) message = `${planIssueDescription(failed)}；网页未改变`
    if (repairsUsed) message += `，已自动修复 ${repairsUsed} 次`
  }
  return {
    code, status, message: `${message}${status ? `（${status}）` : ''}`,
    ...(timeoutPhase ? { timeoutPhase,timeoutMs:Number.isFinite(error.timeoutMs) && error.timeoutMs > 0 ? error.timeoutMs : 0 } : {}),
    ...timeout,
    repairsUsed,
    requestId: /^[\w-]{1,64}$/u.test(error.requestId || '') ? error.requestId : '',
  }
}
