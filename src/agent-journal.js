import { blockingPlanIssues, planIssueDescription, planRepairCount } from './plan-check-policy.js'
import { modelTimeoutMetadata, sanitizeModelAttempts } from './model-diagnostics.js'
const clean = (value, limit = 220) => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, limit)
const actions = { replace: '替换文字', 'replace-image': '替换图片', delete: '删除', insert: '新增内容', reorder: '调整布局', color: '调整颜色', note: '需要补充修改方向' }
const shapes = { circle: '圈', box: '框', arrow: '箭头', cross: '叉', x: '叉', line: '线', drawn: '笔迹', strike: '划线' }
const kinds = { text: '文字', image: '图片', container: '容器', card: '卡片', list: '列表', grid: '网格' }

export function sanitizeAnalysisTimings(value = {}) {
  const timings = {}
  for (const key of ['pauseMs','observationMs','captureMs','baseWaitMs','baseBuildMs','planMs','verifyMs','repairMs',
    'modelRequests','modelAttempts','upstreamMs','serverMs','readToolCalls','imageCount','totalMs','firstSummaryMs','completedPlanMs','evidenceChars','originalEvidenceChars']) {
    if (typeof value?.[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) timings[key] = Math.round(value[key])
  }
  for (const key of ['baseCacheHit','baseShared']) if (typeof value?.[key] === 'boolean') timings[key] = value[key]
  if (Array.isArray(value?.attempts)) timings.attempts = sanitizeModelAttempts(value.attempts)
  return timings
}

export function summarizeOperation(group = {}, instruction = '') {
  const strokes = group.strokes || []
  const counts = new Map()
  for (const stroke of strokes) { const shape = shapes[stroke.shape] || (stroke.closed ? '圈 / 框' : '笔迹'); counts.set(shape, (counts.get(shape) || 0) + 1) }
  const mark = counts.size ? `画了${[...counts].map(([shape, count]) => ` ${count} 个${shape}`).join('、')}` : '选定了修改区域'
  const targets = group.targets || []
  const typeCounts = new Map()
  for (const target of targets) { const kind = kinds[target.kind] || '组件'; typeCounts.set(kind, (typeCounts.get(kind) || 0) + 1) }
  const targetText = targets.length ? `标记${[...typeCounts].map(([kind, count]) => ` ${count} 个${kind}对象`).join('、')}` : '标记了空白位置或尚未命中组件'
  const excerpt = targets.find((target) => target.text)?.text
  const input = clean(instruction || group.customInstruction || group.userInstruction, 400)
  return `${mark}，${targetText}${excerpt ? `（“${clean(excerpt, 40)}”）` : ''}。${input ? `要求：${input}` : ''}`
}

export function summarizeIntent(intent) {
  if (!intent) return ''
  const text = intent.needsClarification ? intent.clarifyingQuestion || intent.suggestion?.text
    : intent.goal || intent.suggestion?.text
  return clean(text || actions[intent.type] || '尚未形成修改建议')
}

// View-only, bounded session data. Never imported by API payload builders or
// behavior memory; no screenshots, full DOM, or hidden reasoning are retained.
export function createAgentJournal({ maxEntries = 100, now = Date.now } = {}) {
  let entries = [], sequence = 0
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener() }
  const update = (id, patch) => {
    const entry = entries.find((item) => item.id === id)
    if (!entry) return false
    Object.assign(entry, patch); notify(); return true
  }
  return {
    begin(group, { instruction = '', model = '', localIntent = null } = {}) {
      const entry = { id: `agent-${++sequence}`, groupId: group?.id || '', revision: group?.revision || 0,
        startedAt: now(), status: 'pending', user: summarizeOperation(group, instruction),
        model: clean(model, 120), localSuggestion: summarizeIntent(localIntent), summary: '正在理解这次标注…', execution: '' }
      entries.push(entry); entries = entries.slice(-maxEntries); notify(); return entry.id
    },
    finish(id, { intent, modelIntent, model = '', issue, source = 'ai', rejected = false, rejectionReason = '', routing, retriesUsed = 0, repairsUsed = 0, trace=[],validation,timings } = {}) {
      const entry = entries.find((item) => item.id === id)
      if (!entry) return false
      return update(id, { status: issue ? 'error' : 'ready', elapsedMs: Math.max(0, now() - entry.startedAt),
        model: clean(model || entry.model, 120), source, rejected, rejectionReason: clean(rejectionReason),
        routing: routing ? `${clean(routing.tier,20)} · ${clean(routing.reason)}` : '', retriesUsed,repairsUsed:planRepairCount(repairsUsed),
        timings: sanitizeAnalysisTimings(timings),
        modelSuggestion: summarizeIntent(modelIntent), summary: summarizeIntent(intent) || '尚未形成修改建议',
        alternatives: (intent?.suggestion?.alternatives || []).slice(0, 3).map((item) => clean(item, 100)),
        stages: trace.slice(-12).map((stage)=>`${clean(stage.stage,24)}：${clean(stage.summary)}${stage.issues?.length ? `：${stage.issues.slice(0,3).map(planIssueDescription).join('、')}` : ''}${stage.elapsedMs != null ? ` · ${(stage.elapsedMs/1000).toFixed(1)}秒` : ''}${stage.error ? `（${clean(stage.error)}）` : ''}`),
        verification: validation ? (validation.ok ? (validation.checks?.includes('execution') ? `隔离执行检查通过${validation.provisionalImage ? '（图片使用尺寸占位，生成后再次检查）' : ''}；修改前仍需确认${validation.warnings?.length ? `；轻微提醒：${validation.warnings.slice(0,3).map(planIssueDescription).join('、')}` : ''}` : '目标与引用检查通过；尚未执行验证') : `检查未通过：${blockingPlanIssues(validation).slice(0,3).map(planIssueDescription).join('、')}`) : '',
        error: clean(issue?.message), errorCode: clean(issue?.code, 64), requestId: clean(issue?.requestId, 64),
        timeoutPhase:['capture','verify','analysis'].includes(issue?.timeoutPhase) ? issue.timeoutPhase : '',
        timeoutSource:modelTimeoutMetadata(issue).timeoutSource || '', timeoutStage:modelTimeoutMetadata(issue).timeoutStage || '',
        timeoutMs:Number.isFinite(issue?.timeoutMs) && issue.timeoutMs > 0 ? Math.min(issue.timeoutMs,180_000) : 0 })
    },
    cancel(id) { return update(id, { status: 'cancelled', summary: '已停止本次分析；以新的标注或操作为准。' }) },
    execution(groupId, label, { failed = false, undo = false } = {}) {
      const entry = [...entries].reverse().find((item) => item.groupId === groupId && item.status !== 'cancelled')
      return entry ? update(entry.id, { execution: clean(label), executionFailed: failed, undone: undo }) : false
    },
    undoLatest() {
      const entry = [...entries].reverse().find((item) => item.execution && !item.executionFailed && !item.undone)
      return entry ? update(entry.id, { execution: '已撤销这次修改', undone: true }) : false
    },
    redoLatest() {
      const entry = [...entries].reverse().find((item) => item.undone)
      return entry ? update(entry.id, { execution: '已重做这次修改', undone: false }) : false
    },
    getEntries() { return structuredClone(entries) },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    clear() { entries = []; notify() },
  }
}
