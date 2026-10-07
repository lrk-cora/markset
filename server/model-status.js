import { requestModelChat } from './model-chat.js'
import { requestFailure, withDeadline } from './retry.js'

// These are probes, not generation jobs. Never call /images/generations here.
export function createModelStatusProbe({ analysis, image, allowCalls, fetchImpl = fetch,
  timeoutMs = 8_000, cooldownMs = 5_000, now = Date.now, listOnly = false, lastCalls = {} }) {
  const running = new Map()
  const recent = new Map()
  const safeModel = (value) => String(value || '').slice(0, 120)
  async function probe(kind) {
    const config = kind === 'analysis' ? analysis : image
    const started = now()
    const base = { kind, model: safeModel(config.model), highModel: safeModel(config.highModel), region: config.region || '',
      configured: Boolean(config.apiKey), invocationVerified: Boolean(lastCalls[kind]), lastSuccess: lastCalls[kind] || null,
      method: kind === 'analysis' && !listOnly ? 'completion' : 'model-list', generationVerified: kind === 'image' && Boolean(lastCalls.image) }
    const done = (state, message, extra = {}) => ({ ...base, state, message,
      checkedAt: now(), elapsedMs: Math.max(0, now() - started), ...extra })
    if (!config.apiKey) return done('unconfigured', '服务端尚未配置密钥')
    if (!allowCalls) return done('disabled', '服务端已关闭模型调用')
    try {
      if (kind === 'analysis' && !listOnly) {
        await requestModelChat({ ...config, fetchImpl, retries: 0, timeoutMs, attemptTimeoutMs: timeoutMs,
          messages: [{ role: 'user', content: 'Reply OK.' }], maxTokens: 8 })
        return done('available', '模型已响应极短请求；未测试复杂视觉分析', { connectionVerified: true, invocationVerified: true })
      }
      return await withDeadline(async (signal) => {
        const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/models`, {
          signal, headers: { Authorization: `Bearer ${config.apiKey}` },
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          if ([401, 403].includes(response.status)) return done('auth-error', '网关鉴权失败，请检查密钥或权限', { status: response.status })
          if ([404, 405].includes(response.status)) return done('unverified', '网关不支持模型列表检测，尚无法确认生图连接', { status: response.status })
          if (response.status === 429) return done('busy', '网关繁忙或额度受限', { status: 429 })
          return done('error', '网关返回异常，稍后重试', { status: response.status })
        }
        const data = await response.json()
        signal.throwIfAborted()
        if (!Array.isArray(data?.data)) return done('unverified', '网关已响应，但模型列表格式无法确认')
        const listed = data.data.some((entry) => entry?.id === config.model)
        const highListed = config.highModel ? data.data.some((entry) => entry?.id === config.highModel) : null
        return listed ? done('available', listOnly ? '官方接口鉴权成功；实际调用结果单独记录。' : '网关鉴权成功，模型已列出；未实际生图', { modelListed: true, highModelListed: highListed, connectionVerified: true })
          : done('unverified', '网关鉴权成功，但列表未列出此模型；不代表无法生图', { modelListed: false })
      }, { timeoutMs, timeoutError: requestFailure('probe timeout', 'probe_timeout', 504) })
    } catch (error) {
      const code = String(error?.code || '')
      if (['probe_timeout','model_gateway_timeout','model_first_output_timeout','model_stream_idle_timeout','model_total_timeout'].includes(code)) return done('timeout', '快速检测超时；不代表模型一定不可用', { status: 504 })
      if (code === 'model_gateway_auth') return done('auth-error', '网关鉴权失败，请检查密钥或权限', { status: error.status })
      if (code === 'model_gateway_rate_limit') return done('busy', '网关繁忙或额度受限', { status: 429 })
      if (code === 'model_gateway_request') return done('error', '模型请求被拒绝，请检查模型配置', { status: error.status })
      if (code === 'model_gateway_empty') return done('unverified', '网关已响应，但极短请求未返回内容；尚未确认模型输出')
      if (code === 'model_gateway_invalid_response') return done('unverified', '网关已响应，但返回格式异常；尚未确认模型输出')
      // Never reflect a provider error body, URL, token, or raw exception.
      return done('error', '未能完成连接检测，请检查网关与网络', { status: Number(error?.status) || 502 })
    }
  }
  function check(kind) {
    if (running.has(kind)) return running.get(kind)
    const last = recent.get(kind)
    if (last && now() - last.checkedAt < cooldownMs) return Promise.resolve({ ...last, cached: true })
    const task = probe(kind).then((result) => { recent.set(kind, result); return result })
      .finally(() => running.delete(kind))
    running.set(kind, task)
    return task
  }
  return async (target = 'all') => {
    if (!['all', 'analysis', 'image'].includes(target)) throw requestFailure('检测对象无效', 'invalid_probe_target', 400)
    const kinds = target === 'all' ? ['analysis', 'image'] : [target]
    return { results: await Promise.all(kinds.map(check)) }
  }
}
