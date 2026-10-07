import { checkModelStatus, fetchHealth, generateImage, testAnalysisModel } from './api.js'
import { modelTimeoutDescription } from './model-diagnostics.js'

const labels = { unchecked: '尚未检测', checking: '检测中', available: '可连接', unconfigured: '未配置', disabled: '已关闭',
  'auth-error': '鉴权失败', unverified: '尚未确认', busy: '繁忙 / 受限', timeout: '检测超时', error: '连接异常' }
const time = (value) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const duration = (ms) => `${(ms / 1000).toFixed(1)} 秒`
const node = (tag, className, text) => {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text) element.textContent = text
  return element
}

export function initDiagnosticsPanel({ journal, root = document }) {
  const models = root.getElementById('model-status-section')
  const log = root.getElementById('agent-record-list')
  const count = root.getElementById('agent-record-count')
  const all = root.getElementById('btn-check-models')
  const states = { analysis: { state: 'unchecked', model: '读取配置中…' }, image: { state: 'unchecked', model: '读取配置中…' } }
  const pending = new Set()
  function renderModels() {
    for (const kind of ['analysis', 'image']) {
      const state = states[kind]
      const card = root.getElementById(`model-card-${kind}`)
      card.dataset.state = state.state
      card.querySelector('.model-name').textContent = [state.model, state.highModel].filter(Boolean).join(' / ') || '未配置模型'
      card.querySelector('.model-state').textContent = labels[state.state] || '尚未确认'
      card.querySelector('.model-message').textContent = `${state.region ? `${state.region} · ` : ''}${state.message || '点击检测，确认当前连接状态。'}${state.lastSuccess ? ` 最近实际成功：${state.lastSuccess.model} · ${duration(state.lastSuccess.elapsedMs || 0)}` : ' 尚未记录实际调用成功。'}`
      card.querySelector('.model-checked').textContent = state.checkedAt
        ? `${time(state.checkedAt)} · ${duration(state.elapsedMs || 0)}${state.cached ? ' · 刚刚检测过' : ''}` : '尚未发起连接检测'
      card.querySelector('button').disabled = pending.has(kind)
      card.setAttribute('aria-busy', String(pending.has(kind)))
    }
    all.disabled = pending.size > 0
    all.textContent = pending.size > 0 ? '检测中…' : '检测全部'
  }
  async function check(target = 'all') {
    const kinds = target === 'all' ? ['analysis', 'image'] : [target]
    // Independent requests let a fast image-list result render immediately,
    // even while the analysis completion is still pending.
    await Promise.all(kinds.map(async (kind) => {
      if (pending.has(kind)) return
      pending.add(kind); states[kind] = { ...states[kind], state: 'checking', message: '正在进行轻量连接检测…' }; renderModels()
      try {
        const data = await checkModelStatus(kind)
        const result = data.results?.find((item) => item.kind === kind)
        if (!result || !labels[result.state]) throw new Error('invalid probe result')
        states[kind] = result
      } catch (error) {
        states[kind] = { ...states[kind], state: error.name === 'TimeoutError' ? 'timeout' : 'error',
          message: '未能完成快速检测，请检查本地服务或稍后重试。', checkedAt: Date.now(), elapsedMs: 0 }
      } finally { pending.delete(kind); renderModels() }
    }))
  }
  models.querySelectorAll('[data-check-model]').forEach((button) => button.addEventListener('click', () => { void check(button.dataset.checkModel) }))
  all.addEventListener('click', () => { void check() })
  for (const kind of ['analysis','image']) {
    const card = root.getElementById(`model-card-${kind}`)
    const verify = node('button', 'button model-verify-button', kind === 'image' ? '实际生图测试（计费）' : '实际分析测试（计费）')
    let imageRequestId = '', imageTaskId = ''
    verify.type = 'button'
    verify.addEventListener('click', async () => {
      if (!window.confirm(imageTaskId ? '将查询原图片测试任务，不重复生成。继续吗？'
        : `将向百炼发起一次${kind === 'image' ? '图片生成' : '分析'}调用，可能产生费用。继续吗？`)) return
      verify.disabled = true
      try {
        const result = kind === 'image' ? await generateImage({ prompt: '简洁的蓝色纸飞机图标，纯白背景，无文字', mode: 'generate' },
          { requestId: imageRequestId ||= crypto.randomUUID() }) : await testAnalysisModel()
        imageRequestId = ''; imageTaskId = ''; verify.textContent = kind === 'image' ? '实际生图测试（计费）' : '实际分析测试（计费）'
        states[kind] = { ...states[kind], invocationVerified: true, lastSuccess: result,
          message: `实际调用成功：${result.model}`, state: 'available' }
        if (result.imageUrl) {
          card.querySelector('.model-test-image')?.remove()
          const img = node('img', 'model-test-image'); img.src = result.imageUrl; img.alt = '本次模型测试图片'; img.style.cssText = 'max-width:100%;border-radius:12px'; card.append(img)
        }
      } catch (error) {
        states[kind] = { ...states[kind], state: 'error', message: error.message }
        if (kind === 'image') {
          imageTaskId = error.taskId || imageTaskId
          if (imageTaskId) verify.textContent = '查询原图片测试任务'
          // Keep the identity even when submission is ambiguous without an ID;
          // the server replays that error rather than charging a second POST.
        }
      }
      finally { verify.disabled = false; renderModels() }
    })
    card.append(verify)
  }

  function renderJournal() {
    const scroll = log.closest('.side-scroll')
    const atBottom = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 50
    const entries = journal.getEntries()
    count.textContent = String(entries.length)
    // Retain details open state while an in-flight analysis finishes.
    const openDetails = new Set([...log.querySelectorAll('details[open]')].map((item) => item.dataset.entry))
    log.replaceChildren()
    if (!entries.length) log.append(node('li', 'agent-empty', '画出标注后，这里会出现操作与分析摘要。'))
    for (const entry of entries) {
      const row = node('li', 'agent-turn')
      row.dataset.entry = entry.id
      const meta = node('div', 'agent-turn-meta', `${time(entry.startedAt)}${entry.elapsedMs != null ? ` · ${duration(entry.elapsedMs)}` : ''}`)
      const user = node('div', 'agent-message agent-user')
      user.append(node('span', 'agent-role', '你'), node('p', '', entry.user))
      const reply = node('div', 'agent-message agent-reply')
      reply.dataset.status = entry.status
      const source = entry.status === 'pending' ? 'Agent · 正在理解' : entry.status === 'cancelled' ? 'Agent · 已停止'
        : entry.source === 'local' ? 'Agent · 本地判断' : entry.source === 'fallback' ? 'Agent · 本地兜底' : 'Agent · AI 分析'
      reply.append(node('span', 'agent-role', source))
      if (entry.error) reply.append(node('p', 'agent-error', entry.error))
      reply.append(node('p', '', entry.summary))
      if (entry.alternatives?.length) reply.append(node('p', 'agent-options', `候选：${entry.alternatives.join(' / ')}`))
      if (entry.execution) reply.append(node('p', `agent-outcome${entry.executionFailed ? ' is-failed' : ''}`, entry.execution))
      else if (!['pending', 'cancelled'].includes(entry.status)) reply.append(node('p', 'agent-outcome', '尚未执行网页修改'))
      const details = node('details', 'agent-details')
      details.dataset.entry = entry.id
      details.open = openDetails.has(entry.id)
      details.append(node('summary', '', '查看判断来源'))
      if (entry.model) details.append(node('p', '', `模型：${entry.model}`))
      if (entry.routing) details.append(node('p', '', `分流：${entry.routing} · 重试 ${entry.retriesUsed || 0} 次`))
      if (entry.repairsUsed) details.append(node('p', '', `自动局部修复：${entry.repairsUsed} 次（与连接重试分开计数）`))
      if (entry.timeoutPhase) details.append(node('p', '', `超时来源：${({capture:'网页截图准备',verify:'本地执行检查',analysis:'前端全流程总时限'})[entry.timeoutPhase]}${entry.timeoutMs ? ` · 上限 ${duration(entry.timeoutMs)}` : ''}`))
      if (modelTimeoutDescription(entry)) details.append(node('p', '', `超时来源：${modelTimeoutDescription(entry)}${entry.timeoutMs ? ` · 上限 ${duration(entry.timeoutMs)}` : ''}`))
      if (entry.localSuggestion) details.append(node('p', '', `本地初判：${entry.localSuggestion}`))
      if (entry.modelSuggestion) details.append(node('p', '', `AI 返回：${entry.modelSuggestion}`))
      const timing = entry.timings || {}
      const stages = [['pauseMs','停笔等待'],['observationMs','页面结构'],['captureMs','截图准备'],['planMs','AI 规划'],['verifyMs','本地校验'],['repairMs','额外修复']]
        .filter(([key]) => timing[key] != null && (timing[key] > 0 || key !== 'repairMs'))
        .map(([key,label]) => `${label} ${duration(timing[key])}`)
      if (stages.length) details.append(node('p','',`耗时：${stages.join(' · ')}`))
      if (timing.firstSummaryMs != null) details.append(node('p','',`首次建议反馈：${duration(timing.firstSummaryMs)}（草案，不是可执行方案）`))
      if (timing.originalEvidenceChars > 0) details.append(node('p','',`结构证据：${timing.evidenceChars} 字符 · 去重前 ${timing.originalEvidenceChars} 字符（视觉证据与校验保留）`))
      if (timing.baseCacheHit != null) details.append(node('p','',`底图：${timing.baseCacheHit ? '缓存命中' : timing.baseShared ? '复用正在准备的截图' : '重新截图'} · 本次等待 ${duration(timing.baseWaitMs || 0)} · ${timing.imageCount || 0} 张视觉证据`))
      if (timing.modelRequests != null) details.append(node('p','',`模型规划 ${timing.modelRequests} 次 · 查证工具 ${timing.readToolCalls || 0} 次${timing.totalMs != null ? ` · 含停笔总耗时 ${duration(timing.totalMs)}` : ''}`))
      for (const attempt of timing.attempts || []) {
        const result = attempt.succeeded ? '完成' : modelTimeoutDescription(attempt) || (attempt.aborted ? '已中止' : '失败')
        details.append(node('p','',[
          `调用 ${attempt.request || 1} / 尝试 ${attempt.attempt || 1}`,
          attempt.status ? `HTTP ${attempt.status}` : '未收到响应头',
          attempt.headersMs != null ? `响应头 ${duration(attempt.headersMs)}` : '',
          attempt.firstOutputMs != null ? `首次有效输出 ${duration(attempt.firstOutputMs)}` : '未收到有效输出',
          attempt.lastProgressMs != null ? `末次有效输出 ${duration(attempt.lastProgressMs)}` : '',
          `耗时 ${duration(attempt.elapsedMs || 0)}`, result,
        ].filter(Boolean).join(' · ')))
      }
      for (const stage of entry.stages || []) details.append(node('p','',stage))
      if (entry.verification) details.append(node('p','',entry.verification))
      if (entry.rejected) details.append(node('p', '', `AI 方案未通过执行校验：${entry.rejectionReason || '方案字段缺失'}；未应用网页修改。`))
      if (entry.errorCode) details.append(node('p', '', `诊断：${entry.errorCode}${entry.requestId ? ` · ${entry.requestId}` : ''}`))
      if (details.childElementCount > 1) reply.append(details)
      row.append(meta, user, reply); log.append(row)
    }
    if (atBottom && !root.getElementById('agent-record-section').hidden) scroll.scrollTop = scroll.scrollHeight
  }
  root.getElementById('btn-clear-agent-records').addEventListener('click', () => journal.clear())
  journal.subscribe(renderJournal)
  renderModels(); renderJournal()
  // Configuration is local only. Opening/reloading the app does not call a
  // paid model or imply that merely having a key means the model is online.
  void fetchHealth().then((health) => {
    for (const kind of ['analysis', 'image']) {
      if (states[kind].state !== 'unchecked') continue
      const configured = kind === 'analysis' ? health.modelGateway : health.imageGateway
      states[kind] = { state: !configured ? 'unconfigured' : !health.allowCalls ? 'disabled' : 'unchecked',
        model: kind === 'analysis' ? health.brushModel : health.imageModel,
        highModel: kind === 'analysis' ? health.maxModel : health.imageProModel, region: health.region,
        lastSuccess: health.lastCalls?.[kind] || null,
        message: !configured ? '服务端尚未配置密钥' : !health.allowCalls ? '服务端已关闭模型调用' : '已配置；连接状态需要检测确认。' }
    }
    renderModels()
  }).catch(() => {
    for (const kind of ['analysis', 'image']) if (states[kind].state === 'unchecked') states[kind] = { ...states[kind], model: '', message: '本地服务配置读取失败，点击检测可重试。' }
    renderModels()
  })
  return { check, getAnalysisModel: () => states.analysis.model === '读取配置中…' ? '' : states.analysis.model || '' }
}
