import './styles.css'
import { applyImportedPage, createEditor, refreshDecorations, showStartGuide } from './editor.js'
import { generateImage, importPage, planBrushIntent } from './api.js'
import { aabb, classifyMarkShape, classifyStrokeShape } from './geometry.js'
import { bindLasso, clearPaintMarks, disarmDrawing, SELECT_COLOR, setLassoMode, setPaintMarks } from './overlay.js'
import { applyBrushPlan, attachBrushLayoutAnchor, brushOriginalImage, applyBrushColor, applyBrushDelete, applyBrushImageReplacement, applyBrushLayoutReorder, applyBrushTextDeletion, applyBrushTextReplacement, excludeBrushTargets, expandBrushTargets, exportWebDoc, hitWebDoc, insertWebText, isWebDocActive, listWebEdits, liveScreenRect, observeBrushPage, redoWebEdit, refreshBrushTargetGeometry, refreshWebDocLayout, resolveBrushLayoutRect, screenToWebDocumentPoint, screenToWebDocumentRect, webDocumentRectToScreen, webDocumentToScreenPoint, undoWebEditsSince, unmountWebDoc, verifyBrushPlan } from './web-doc.js'
import { addHistory, addPreference, clearGroup, clearPreferences, getBrushState, patchBrush, patchGroup, patchGroupAnalysis, resetBrushState, setPreferenceRecording, startGroup, subscribeBrush } from './brush-store.js'
import { interpretGroup } from './gesture-interpreter.js'
import { reflowBrushGroup, verifyReflowedBrushPlan } from './brush-layout.js'
import { buildBrushRegions, hasBrushRegionReference, positionBrushRegionLabels } from './brush-regions.js'
import { planningTargets } from './edit-capabilities.js'
import { inferCompleteActionPlan, inferLocalActionPlan, isDurablePreference, isEditInstruction, parseExplicitTextReplacement, validateIntentPlan } from './intent-plan.js'
import { bindIntentSubmission, finishIntentSubmission } from './intent-submission.js'
import { analysisRecoveryIntent, runAnalysisTask } from './analysis-task.js'
import { analysisIssue } from './analysis-errors.js'
import { sanitizeModelAttempts } from './model-diagnostics.js'
import { blockingPlanIssues, planCheckReport, planIssueDescription } from './plan-check-policy.js'
import { analysisProgressView } from './analysis-progress.js'
import { proposalStatus, renderProposalStatus } from './proposal-status.js'
import { MODEL_CLIENT_TIMEOUT_MS } from './request-policy.js'
import { deselectTargetPatch, retargetSelectionPlan, mergeHitTargets } from './target-selection.js'
import { createImportedPageCache } from './imported-page-cache.js'
import { createImportedPageSession } from './imported-page-session.js'
import { createAgentJournal } from './agent-journal.js'
import { initDiagnosticsPanel } from './diagnostics-panel.js'
import { getBrushSettings, subscribeBrushSettings } from './brush-settings.js'
import { initBrushSettingsPanel } from './brush-settings-panel.js'
import { candidateForChoice, clarificationChoices, clarificationNeedsContent, formatClarificationAnswer, isAnnotationChoice, recommendedClarificationChoice, wasClarificationAnswered } from './proposal-choices.js'
import { clearBehaviorOverrides, getAgentBehaviorContext, getBehaviorMemory, getEffectiveBehaviorProfile, markLatestEpisodeUndone, recordEditEpisode, recordExplicitPreference, removeMemory, setBehaviorLearning, setBehaviorPreference, subscribeBehaviorMemory } from './behavior-memory.js'

const editor = createEditor(document.getElementById('editor'))
showStartGuide()

const $ = (id) => document.getElementById(id)
const els = {
  page: $('page-shell'), guide: $('start-guide'), import: $('btn-import-html'), guideImport: $('btn-guide-import'), export: $('btn-export-html'), undo: $('btn-undo'), redo: $('btn-redo'), brush: $('btn-brush'), clearStrokes: $('btn-clear-strokes'), modePill: $('mode-pill'), empty: $('empty-state'), brushState: $('brush-state'), proposal: $('proposal-section'), proposalText: $('proposal-text'), proposalConfidence: $('proposal-confidence'), proposalAlternatives: $('proposal-alternatives'), replaceEditor: $('replace-editor'), replaceInput: $('replace-input'), preview: $('btn-preview'), proposalActions: $('proposal-actions'), layoutPreview: $('btn-preview-layout'), apply: $('btn-apply'), keepDrawing: $('btn-keep-drawing'), dismiss: $('btn-dismiss'), hint: $('proposal-hint'), analysis: $('analysis-state'), history: $('history-section'), historyCount: $('history-count'), historyList: $('history-list'), preferenceStatus: $('preference-status'), preferenceRecording: $('preference-recording'), preferenceList: $('preference-list'), clearPreferences: $('btn-clear-preferences'), behaviorClearAction: $('behavior-clear-action'), behaviorAmbiguousMode: $('behavior-ambiguous-mode'), behaviorTextScope: $('behavior-text-scope'), behaviorEditStyle: $('behavior-edit-style'), clearBehavior: $('btn-clear-behavior'), panel: document.querySelector('.side-panel'), panelHeading: document.querySelector('.panel-heading-copy h2'), ghost: $('ghost-layer'), inlineProposal: $('inline-proposal'), inlineKind: $('inline-proposal-kind'), inlineText: $('inline-proposal-text'), inlineError: $('inline-error-message'), inlineAlternatives: $('inline-proposal-alternatives'), inlineCustom: $('inline-custom-intent'), inlineCustomInput: $('inline-custom-intent-input'), inlineCustomSubmit: $('btn-inline-custom-intent'), inlineInput: $('inline-replace-input'), inlinePrimary: $('btn-inline-primary'), inlineRetry: $('btn-inline-retry'), inlineDetails: $('btn-inline-details'), inlineDismiss: $('btn-inline-dismiss'), togglePanel: $('btn-toggle-panel'), toast: $('toast'),
}
let panelView = 'home'
let analysisTimer = null
let toastTimer = null
let modelRequestSeq = 0
let modelAbortController = null
const agentJournal = createAgentJournal()
const diagnosticsPanel = initDiagnosticsPanel({ journal: agentJournal })
initBrushSettingsPanel()
let activeJournalId = null
const BRUSH_MODEL_TIMEOUT_MS = MODEL_CLIENT_TIMEOUT_MS
let strokeActive = false
let evidenceWarmup = null
let analysisClock = null

function stopAnalysisClock() { clearInterval(analysisClock); analysisClock = null }
function renderAnalysisProgress(group) {
  if (!group || !(group.modelPending || group.status === 'analyzing') || group.applying || strokeActive) return stopAnalysisClock()
  const view = analysisProgressView(group.analysisProgress)
  renderProposalStatus(els.inlineProposal,$('inline-status-visual'),proposalStatus(group,{pending:true}))
  els.inlineKind.textContent = view.kind
  els.inlineText.textContent = view.headline
  const detail = $('inline-analysis-progress')
  if (detail) { detail.hidden = false; detail.textContent = view.detail }
  els.inlinePrimary.textContent = view.button
  els.inlinePrimary.disabled = true
  if (analysisClock == null) {
    analysisClock = setInterval(() => renderAnalysisProgress(getBrushState().group), 1000)
    analysisClock.unref?.()
  }
}

function cancelEvidenceWarmup() {
  if (evidenceWarmup != null) {
    if (window.cancelIdleCallback) window.cancelIdleCallback(evidenceWarmup)
    else clearTimeout(evidenceWarmup)
  }
  evidenceWarmup = null
}
function scheduleEvidenceWarmup() {
  cancelEvidenceWarmup()
  const warm = () => {
    evidenceWarmup = null
    // Capture only the CLEAN base. Never freeze incomplete ink or start an
    // early model call; analysis still waits for the configured pause.
    void import('./capture.js').then(({ warmAnnotationBase }) => warmAnnotationBase?.()).catch(() => {})
    const group = getBrushState().group
    if (group && !strokeActive) {
      try { observeBrushPage(group) } catch { /* foreground analysis reports failures */ }
    }
  }
  evidenceWarmup = window.requestIdleCallback ? window.requestIdleCallback(warm, { timeout: 300 }) : setTimeout(warm, 60)
}

function toast(message) {
  els.toast.textContent = message
  els.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { els.toast.hidden = true }, 2600)
}
function confidenceLabel(value) { return value >= 0.75 ? '高置信度' : value >= 0.55 ? '中等置信度' : '需要确认' }
function proposalAnchor(group) {
  // The card belongs to the gesture, not to the full DOM hit area. Using the
  // stroke bounds keeps it close to the brush's lower-right corner even when a
  // large heading or paragraph was hit by the same gesture.
  const points = group?.strokes?.flatMap((stroke) => stroke.points || []) || []
  const bounds = points.length ? aabb(points) : null
  if (bounds) {
    return group.coordinateSpace === 'web-document'
      ? webDocumentRectToScreen(bounds)
      : { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }
  }

  const rects = (group?.targets || []).map((target) => liveScreenRect(target) || target.screenRect).filter(Boolean)
  if (rects.length) {
    const box = rects.reduce((acc, rect) => ({
      x: Math.min(acc.x, rect.x),
      y: Math.min(acc.y, rect.y),
      right: Math.max(acc.right, rect.x + rect.w),
      bottom: Math.max(acc.bottom, rect.y + rect.h),
    }), { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity })
    return { x: box.x, y: box.y, w: box.right - box.x, h: box.bottom - box.y }
  }
  return null
}

function proposalTargetRects(group) {
  return (group?.targets || [])
    .map((target) => liveScreenRect(target) || target.screenRect)
    .filter(Boolean)
}

function positionInlineProposal(group) {
  const anchor = proposalAnchor(group)
  if (!anchor) return
  const card = els.inlineProposal
  const margin = 18
  const gap = 16
  const width = Math.min(330, Math.max(260, card.offsetWidth || 300))
  const height = card.offsetHeight || 150
  const sidePanel = document.querySelector('.side-panel')
  const panelLimit = !document.body.classList.contains('is-panel-collapsed') && sidePanel
    ? sidePanel.getBoundingClientRect().left - margin
    : window.innerWidth - margin
  const safeLeft = margin
  const safeRight = Math.max(safeLeft + width, panelLimit)
  const safeTop = margin + 48
  const safeBottom = window.innerHeight - margin
  const targetRects = proposalTargetRects(group)
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
  const overlapsContent = (candidate) => targetRects.some((rect) => !(
    candidate.right <= rect.x || candidate.left >= rect.x + rect.w ||
    candidate.bottom <= rect.y || candidate.top >= rect.y + rect.h
  ))
  const makeCandidate = (left, top, placement) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    placement,
  })
  const fits = (candidate) => (
    candidate.left >= safeLeft &&
    candidate.right <= safeRight &&
    candidate.top >= safeTop &&
    candidate.bottom <= safeBottom &&
    !overlapsContent(candidate)
  )

  // Anchor the suggestion to the brush itself. The lower-right corner is the
  // primary position; other positions are only used when the viewport or the
  // side panel leaves no room there.
  const belowRight = clamp(anchor.x + anchor.w - width + 12, safeLeft, safeRight - width)
  const belowLeft = clamp(anchor.x, safeLeft, safeRight - width)
  const overlappingTargetBottom = targetRects
    .filter((rect) => rect.x < belowRight + width && rect.x + rect.w > belowRight)
    .reduce((bottom, rect) => Math.max(bottom, rect.y + rect.h), 0)
  const belowTop = Math.max(anchor.y + anchor.h + gap, overlappingTargetBottom + gap)
  const rightTop = clamp(anchor.y + anchor.h - height, safeTop, safeBottom - height)
  const leftTop = clamp(anchor.y + anchor.h - height, safeTop, safeBottom - height)
  const aboveRight = clamp(anchor.x + anchor.w - width + 12, safeLeft, safeRight - width)
  const candidates = [
    makeCandidate(belowRight, belowTop, 'below'),
    makeCandidate(belowLeft, belowTop, 'below'),
    makeCandidate(anchor.x + anchor.w + gap, rightTop, 'right'),
    makeCandidate(anchor.x - width - gap, leftTop, 'left'),
    makeCandidate(aboveRight, anchor.y - height - gap, 'above'),
  ]
  const chosen = candidates.find(fits) || makeCandidate(
    belowRight,
    clamp(belowTop, safeTop, safeBottom - height),
    'edge',
  )

  card.classList.toggle('is-below', chosen.placement === 'below')
  card.dataset.placement = chosen.placement
  card.style.left = Math.round(chosen.left) + 'px'
  card.style.top = Math.round(chosen.top) + 'px'
}

function actionChoiceLabel(type) {
  return ({
    reorder: '重新排列这些对象',
    replace: '替换文字内容',
    'replace-image': '替换图片',
    color: '修改颜色',
    delete: '移除所选内容',
    insert: '在这里新增内容',
    note: '',
  })[type] || ''
}

function intentChoices(intent) {
  if (intent?.clarificationAlreadyAnswered) return []
  if (clarificationNeedsContent(intent)) return []
  if (getEffectiveBehaviorProfile().ambiguousMode === 'input') return []
  const labels = []
  // A neutral mark is not an instruction: show possible edits without claiming
  // that an annotation is the recommended outcome.
  if (intent?.source === 'model' && !intent.needsClarification) return []
  if (intent?.source !== 'model' && intent?.type && intent.type !== 'note') labels.push(actionChoiceLabel(intent.type))
  const isLocalFallback = intent?.source === 'local-fallback'
  const alternatives = (intent?.needsClarification && !isLocalFallback
    ? clarificationChoices(intent, intent?.targets || [])
    : (intent?.suggestion?.alternatives || []))
    .filter((item) => !isAnnotationChoice(item))
  labels.push(...alternatives)
  const choices = [...new Set(labels.filter(Boolean))].slice(0, 4)
  // A mark always represents an intended edit. Leaving the page unchanged is
  // handled by clicking away, never as a competing recommendation.
  return choices
    .filter((choice) => !isAnnotationChoice(choice))
    .filter((choice) => intent?.source === 'model' || !/移除|删除|去掉|删掉/u.test(choice) || hasDeleteEvidence(intent, getBrushState().group || {}))
}

function recommendedChoice(intent, choices) {
  return recommendedClarificationChoice(intent, choices)
}

function proposalHeadline(intent, group) {
  if (intent?.source === 'model' && group?.analysisIssue) return intent.suggestion?.text || '方案未通过检查，可以调整要求或重试'
  if (intent?.clarificationAlreadyAnswered) return '已记录你的选择，请补充最终内容或其他要求'
  if (intent?.needsClarification && intent.clarifyingQuestion) return intent.clarifyingQuestion
  if (intent?.source === 'model' && intent.type !== 'note') return intent.suggestion?.text || intent.goal
  const count = Math.max(1, intent?.targets?.length || group?.targets?.length || 1)
  const target = count > 1 ? `${count} 个标记对象` : '标记对象'
  const direction = intent?.parameters?.direction === 'vertical' ? '纵向' : '横向'
  if (intent?.type === 'reorder') return `将 ${target}${direction}排列`
  if (intent?.type === 'delete') return `移除${target}`
  if (intent?.type === 'replace') return `替换${target}中的文字`
  if (intent?.type === 'replace-image') return `更换${target}中的图片`
  if (intent?.type === 'color') return `将${target}改为${intent.parameters?.color || intent.color || intent.replacementText || '指定颜色'}`
  if (intent?.type === 'insert') return intent.goal || '在标记位置添加内容'
  if (intent?.type === 'batch') return intent.suggestion?.text || intent.goal
  if (intent?.needsClarification && intent.clarifyingQuestion) return intent.clarifyingQuestion
  return '选择或补充修改方式'
}

function renderInlineProposal(group) {
  const manual = group?.status === 'draft' && (!getBrushSettings().autoAnalyze || group.analysisPaused)
  const pendingModel = Boolean((group?.modelPending || group?.status === 'analyzing') && !group.intentLocked && !group.applying)
  // A manual request can start before any local/AI suggestion exists. The
  // pending surface must not depend on an executable intent already arriving.
  const intent = manual || pendingModel && !group?.inferredIntent
    ? { type:'note',suggestion:{alternatives:[]} } : group?.inferredIntent
  const analyzeButton = $('btn-analyze-strokes')
  analyzeButton.hidden = (!manual && !pendingModel) || strokeActive
  analyzeButton.disabled = Boolean(group?.applying)
  analyzeButton.dataset.action = pendingModel ? 'cancel' : 'analyze'
  analyzeButton.textContent = pendingModel ? '取消分析' : '开始分析'
  analyzeButton.classList.toggle('button-secondary', pendingModel)
  analyzeButton.classList.toggle('button-primary', !pendingModel)
  const progressDetail = $('inline-analysis-progress')
  if (progressDetail) progressDetail.hidden = !pendingModel || strokeActive
  if (!pendingModel || strokeActive) stopAnalysisClock()
  if (!group || !intent || strokeActive || group.status === 'draft' && !manual) {
    els.inlineProposal.hidden = true
    return
  }
  els.inlineProposal.hidden = false
  const modelError = Boolean(group.modelError)
  const issue = group.status === 'analyzing' ? null : group.imageError || group.analysisIssue
  const localFallback = intent?.source === 'local-fallback'
  const ambiguous = !modelError && !intent?.needsInput && (intent.needsClarification || intent.type === 'note')
  const wantsContent = !modelError && Boolean(intent?.needsInput || clarificationNeedsContent(intent))
  const visualType = modelError ? 'error' : wantsContent ? 'input' : ambiguous ? 'clarification' : intent.type || 'edit'
  els.inlineProposal.dataset.variant = visualType
  els.inlineProposal.classList.toggle('is-error', modelError)
  els.inlineProposal.classList.toggle('has-analysis-issue', Boolean(issue))
  els.inlineProposal.classList.toggle('is-ambiguous', ambiguous)
  renderProposalStatus(els.inlineProposal,$('inline-status-visual'),proposalStatus(group,{manual,pending:pendingModel,issue,wantsContent,ambiguous}))
  els.inlineKind.textContent = modelError ? '分析未完成' : pendingModel ? 'AI 正在分析' : group.status === 'analyzing' ? '正在理解' : localFallback ? '本地判断' : intent.clarificationAlreadyAnswered ? '补充最后信息' : wantsContent ? '需要补充内容' : ambiguous ? '需要确认意图' : ({ color: '颜色调整', reorder: '布局调整', replace: '文字替换', 'replace-image': '图片替换', delete: '内容移除', insert: '添加内容' })[intent.type] || '修改建议'
  if (!pendingModel && !modelError && intent.source === 'model') els.inlineKind.textContent = `AI · ${els.inlineKind.textContent}`
  els.inlineText.textContent = modelError ? '暂未形成可靠的修改方案' : pendingModel ? '标注已保留，正在理解修改意图…' : group.status === 'analyzing' ? '正在理解这条修改要求…' : proposalHeadline(intent, group)
  if (issue) els.inlineKind.textContent = group.imageError ? '图片任务未完成' : intent.source === 'model' ? '方案未完成' : 'AI 未完成 · 本地方案'
  if (manual) {
    els.inlineKind.textContent = '待分析'
    els.inlineText.textContent = '标注已保留，画完后开始分析。'
  }
  els.inlineError.hidden = !modelError && !issue
  els.inlineError.textContent = issue ? `${issue.message}。笔迹和输入已保留。` : modelError ? '这次分析没有完成，网页没有被修改。请稍后重试理解。' : ''
  els.inlineError.title = issue?.requestId ? `诊断编号：${issue.requestId}` : ''
  const warningLine = $('inline-check-warning')
  if (warningLine) {
    const warnings = !issue && !pendingModel && !manual ? group.validation?.warnings || [] : []
    warningLine.hidden = !warnings.length
    warningLine.textContent = warnings.length ? `轻微提醒：${planIssueDescription(warnings[0])}；仍可修改并撤销。` : ''
  }
  const detail = $('inline-plan-detail')
  if (detail) {
    // The inline surface is for decisions, not diagnostics. Keep rationale,
    // constraints and model details out of the small overlay.
    detail.textContent = ''
    detail.hidden = true
  }
  const choices = modelError ? [] : intentChoices(intent)
  const substantiveAlternatives = (intent.suggestion?.alternatives || []).filter((item) => !isAnnotationChoice(item))
  const needsChoices = !modelError && getEffectiveBehaviorProfile().ambiguousMode !== 'input' && !wantsContent && !intent.clarificationAlreadyAnswered && choices.length > 0 && (intent.type === 'note' || intent.needsClarification || substantiveAlternatives.length > 0)
  const previewing = group.status === 'previewing'
  const intentChosen = Boolean(group.intentLocked)
  els.inlineAlternatives.hidden = manual || pendingModel || previewing || intentChosen || group.status === 'analyzing' || !needsChoices
  els.inlineAlternatives.replaceChildren()
  if (!els.inlineAlternatives.hidden) {
    const label = document.createElement('div')
    label.className = 'inline-proposal-choice-label'
    label.textContent = group.selectedAlternative ? '已选中，可继续补充后再修改' : '选一个方向，可补充后再修改'
    els.inlineAlternatives.append(label)
    const recommended = recommendedChoice(intent, choices)
    choices.forEach((choice, index) => {
      const isRecommended = choice === recommended
      const button = document.createElement('button')
      const selected = choice === group.selectedAlternative
      button.type = 'button'
      button.className = `inline-alternative-button${isRecommended ? ' is-recommended' : ''}${selected ? ' is-selected' : ''}`
      button.setAttribute('aria-pressed', String(selected))
      button.setAttribute('aria-label', `${choice}${isRecommended ? '，推荐方案' : ''}${selected ? '，已选择' : ''}`)
      button.textContent = choice
      if (isRecommended) {
        const badge = document.createElement('span')
        badge.className = 'recommendation-badge'
        badge.textContent = '推荐'
        button.append(badge)
      }
      button.addEventListener('click', () => {
        if (intent.needsClarification || intent.type === 'note') {
          // Choosing an answer should not submit it. Keep the answer editable,
          // so users can add the missing content before one analysis pass.
          patchGroup({ selectedAlternative: choice })
          render()
        }
        else selectIntentAlternative(choice, intent)
      })
      els.inlineAlternatives.append(button)
    })
  }
  // The feedback field is always available. It is the user's correction lane,
  // not another decision tree hidden behind “detailed editing”.
  const analyzing = Boolean(group.applying)
  const needsInput = !pendingModel && !modelError && Boolean(intent.needsInput || wantsContent)
  const feedback = document.querySelector('.inline-feedback')
  if (feedback) feedback.hidden = modelError || analyzing || needsInput
  els.inlineCustom.hidden = modelError || analyzing || needsInput
  els.inlineCustomInput.disabled = analyzing || modelError
  els.inlineInput.hidden = modelError || analyzing || !needsInput
  els.inlineInput.disabled = analyzing || modelError
  const feedbackLabel = document.querySelector('.inline-feedback-label')
  if (feedbackLabel) feedbackLabel.textContent = group.selectedAlternative ? '已选方向，可补充要求' : '有补充或想调整？'
  els.inlineInput.placeholder = ({
    replace: '输入要替换的新内容…', color: '输入目标颜色…',
    'replace-image': '输入图片链接…', insert: '输入要添加的内容…',
  })[intent.type] || '补充具体修改要求…'
  els.inlineCustomInput.placeholder = group.selectedAlternative ? '补充要求（可留空）…' : '输入具体要求…'
  // Inputs are controlled by the current modification group. Never preserve a
  // DOM value from the preceding question/group just because it had focus.
  els.inlineInput.value = modelError ? '' : (group.replacementText || '')
  els.inlineCustomInput.value = modelError ? '' : (group.feedbackDraft || '')
  els.inlinePrimary.hidden = manual || modelError
  els.inlineRetry.hidden = !modelError && !issue
  els.inlineRetry.textContent = group.imageError ? (group.imageTaskId ? '查询原图片任务' : '重试图片连接') : '重试 AI'
  els.inlineRetry.disabled = analyzing
  const pendingWithoutInput = pendingModel && !String(group.feedbackDraft || group.replacementText || '').trim()
  els.inlinePrimary.disabled = analyzing || pendingModel || issue?.code === 'agent_plan_invalid'
  const actionable = !modelError && !intent.needsClarification && ['reorder', 'delete', 'replace', 'replace-image', 'insert', 'color', 'style', 'move', 'batch'].includes(intent.type)
  const preferPreview = getEffectiveBehaviorProfile().clearIntentAction === 'preview' && actionable && !needsInput
  els.inlinePrimary.textContent = group.applying ? '正在准备修改…' : analyzing ? '正在理解…' : pendingWithoutInput ? '正在分析…' : pendingModel ? '提交要求' : previewing ? '确认应用' : preferPreview ? '预览' : '修改'
  els.inlinePrimary.dataset.action = pendingModel ? 'feedback' : previewing ? 'apply' : actionable ? (preferPreview ? 'preview' : 'direct') : 'feedback'
  els.inlineDetails.hidden = true
  els.inlineCustomSubmit.disabled = analyzing || pendingModel
  els.inlineProposal.setAttribute('aria-busy', String(pendingModel))
  if (pendingModel) renderAnalysisProgress(group)
  positionInlineProposal(group)
}

function intentTypeFromAlternative(alternative) {
  const text = String(alternative || '')
  if (text.includes('颜色') || /变红|变蓝|变绿|改为红|改成红/u.test(text)) return 'color'
  if (text.includes('排列') || text.includes('重排')) return 'reorder'
  if (/新增|添加|插入/u.test(text)) return 'insert'
  if (text.includes('图片') || text.includes('配图')) return 'replace-image'
  if (text.includes('移除') || text.includes('删除')) return 'delete'
  if (text.includes('新增') || text.includes('添加')) return 'insert'
  if (text.includes('批注')) return 'note'
  return 'replace'
}

function selectIntentAlternative(alternative, currentIntent) {
  const group = getBrushState().group
  if (!group || !currentIntent) return
  const type = intentTypeFromAlternative(alternative)
  const needsInput = ['replace', 'replace-image', 'insert'].includes(type)
  const textTargets = (group.targets || []).filter((target) => target.kind === 'text' && target.text)
  const selectedText = type === 'replace' && textTargets.length === 1 ? textTargets[0] : null
  const targetText = selectedText ? String(selectedText.text) : ''
  patchGroup({
    inferredIntent: {
      ...currentIntent,
      type,
      operation: type === 'replace' ? 'replace_text' : type,
      needsInput,
      targetText,
      replacementText: '',
      targetRanges: selectedText ? [{ targetId: String(selectedText.webId), start: 0, end: targetText.length }] : [],
      goal: alternative,
      rationale: '这是用户亲自选择的修改方式。',
      strategy: alternative,
      constraints: ['只作用于已标记对象', '正式应用前由用户确认'],
      impact: { scope: String(group.targets.length) + ' 个所选对象', riskLevel: type === 'delete' ? 'medium' : 'low' },
      needsClarification: false,
      confidence: type === 'note' ? 1 : Math.max(0.9, currentIntent.confidence || 0),
      suggestion: { ...currentIntent.suggestion, text: alternative },
      source: 'user',
    },
    intentLocked: true,
    selectedAlternative: '',
    preview: null,
    replacementText: needsInput ? group.replacementText || '' : '',
    status: 'suggested',
  })
  render()
  if (needsInput) requestAnimationFrame(() => els.inlineInput.focus())
}

function renderGhost(group) {
  els.ghost.replaceChildren()
  const intent = group?.inferredIntent
  if (!intent) return
  const sourceTargets = group.preview && intent.targets?.length ? intent.targets : (group.targets || [])
  const targets = sourceTargets.map((target) => ({
    target,
    rect: liveScreenRect(target) || target.screenRect,
  })).filter((item) => item.rect)
  const direction = intent.type === 'reorder'
    ? (intent.parameters?.direction || 'horizontal')
    : 'horizontal'
  const previewing = Boolean(group.preview)
  const ordered = direction === 'vertical'
    ? [...targets].sort((a, b) => a.rect.y - b.rect.y)
    : [...targets].sort((a, b) => a.rect.x - b.rect.x)
  if (intent.type === 'reorder' && intent.parameters?.order === 'reverse') ordered.reverse()
  const gap = 18
  const origin = ordered[0]?.rect
  for (const [index, item] of ordered.entries()) {
    const { target, rect } = item
    const box = document.createElement('div')
    box.className = `ghost-target ${previewing ? 'is-preview' : 'is-target'}${intent.type === 'reorder' ? ' is-layout' : ''}${intent.type === 'delete' ? ' is-delete' : ''}`
    let x = rect.x
    let y = rect.y
    if (intent.type === 'reorder' && previewing && origin) {
      if (direction === 'vertical') y = origin.y + index * (origin.h + gap)
      else x = origin.x + index * (origin.w + gap)
    }
    box.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(12, rect.w)}px;height:${Math.max(12, rect.h)}px`
    if (intent.type === 'delete' && previewing) {
      const label = document.createElement('span')
      label.className = 'ghost-delete-label'
      label.textContent = '将移除'
      box.append(label)
    } else if (intent.type === 'replace' && previewing) {
      const copy = document.createElement('span')
      copy.className = 'ghost-copy'
      copy.textContent = `${intent.targetText || ''} → ${intent.replacementText || group.replacementText || ''}`
      box.append(copy)
    } else if (intent.type === 'replace-image' && previewing && group.replacementText) {
      const image = document.createElement('img')
      image.className = 'ghost-media'
      image.src = group.replacementText
      image.alt = `图片替换预览：${target.text || '图片'}`
      box.append(image)
    } else if (intent.type === 'reorder') {
      const label = document.createElement('span')
      label.className = 'ghost-arrow'
      label.textContent = previewing ? String(index + 1) : '↔'
      box.append(label)
    }
    els.ghost.append(box)
  }
  if (intent.type === 'insert' && intent.parameters?.bounds) {
    const b = intent.parameters.bounds
    const screenBox = intent.parameters.coordinateSpace === 'web-document' ? webDocumentRectToScreen(b) : b
    const box = document.createElement('div')
    box.className = 'ghost-insert'
    box.style.cssText = `left:${screenBox.x}px;top:${screenBox.y}px;width:${Math.max(80, screenBox.w)}px;height:${Math.max(50, screenBox.h)}px`
    box.textContent = group.replacementText || '新增内容'
    els.ghost.append(box)
  }
}

function renderTargetControls(group) {
  const layer = $('target-controls-layer')
  layer.replaceChildren()
  if (!group || strokeActive) return
  for (const target of group.targets || []) {
    const rect = liveScreenRect(target) || target.screenRect
    if (!rect || rect.x + rect.w < 0 || rect.y + rect.h < 72 || rect.x > window.innerWidth || rect.y > window.innerHeight) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'target-deselect app-ui'
    button.textContent = '×'
    button.title = '取消选中（不会删除网页内容）'
    button.setAttribute('aria-label', `取消选中：${String(target.text || (target.kind === 'image' ? '图片' : '组件')).slice(0, 32)}`)
    button.dataset.targetId = String(target.webId)
    button.style.left = `${Math.max(4, Math.min(window.innerWidth - 28, rect.x + rect.w - 12))}px`
    button.style.top = `${Math.max(76, Math.min(window.innerHeight - 28, rect.y - 12))}px`
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      deselectTarget(target.webId, group.id)
      if (event.detail === 0) requestAnimationFrame(() => (layer.querySelector('button') || els.brush).focus())
    })
    layer.append(button)
  }
}

function numberedBrushRegions(group) {
  return buildBrushRegions(group, target => {
    const rect = liveScreenRect(target) || target.screenRect || target.imageRect
    return group.coordinateSpace === 'web-document' && rect ? screenToWebDocumentRect(rect) : rect || target.documentRect
  })
}

function renderRegionNumbers(group) {
  const layer = $('region-labels-layer')
  layer.replaceChildren()
  if (!group || strokeActive) return
  const regions = numberedBrushRegions(group)
  if (regions.length < 2) return
  const stage = document.querySelector('.stage')?.getBoundingClientRect()
  if (stage) layer.style.clipPath = `inset(${Math.max(72, stage.top || 0)}px ${Math.max(0, window.innerWidth - stage.left - stage.width)}px ${Math.max(0, window.innerHeight - stage.top - stage.height)}px ${Math.max(0, stage.left)}px)`
  const projected = regions.flatMap(region => {
    const rect = region.coordinateSpace === 'web-document' ? webDocumentRectToScreen(region.rect) : region.rect
    return rect ? [{ ...region, rect }] : []
  })
  for (const { region, x, y } of positionBrushRegionLabels(projected)) {
    const badge = document.createElement('span')
    badge.className = 'region-number'
    badge.textContent = String(region.number)
    badge.setAttribute('aria-label', `区域 ${region.number}${region.kind === 'blank' ? '：空白位置' : ''}`)
    badge.dataset.regionId = region.id
    badge.dataset.regionNumber = String(region.number)
    badge.style.left = `${x}px`
    badge.style.top = `${y}px`
    layer.append(badge)
  }
}

function interpretSelectedTargets(group) {
  return (group.excludedTargetIds?.length ? retargetSelectionPlan(group) : null) || interpretGroup(group)
}

function deselectTarget(targetId, groupId) {
  const group = getBrushState().group
  if (!group || group.id !== groupId || strokeActive) return
  const patch = deselectTargetPatch(group, targetId, excludeBrushTargets)
  if (!patch) return
  clearTimeout(analysisTimer)
  cancelModelAnalysis()
  // An explicitly emptied selection is cancellation, not an insertion site.
  // Keep brush mode on so the user can immediately draw a fresh selection.
  if (!patch.targets.length) {
    clearPaintMarks(); clearGroup()
    toast('已取消全部选中，网页内容未改变')
    return
  }
  const next = { ...group, ...patch }
  let intent
  try { intent = interpretSelectedTargets(next) }
  catch { intent = analysisRecoveryIntent(next) }
  const sameAction = intent.type === group.inferredIntent?.type
  patchGroup({
    ...patch, inferredIntent: intent, localIntent: intent, suggestion: intent.suggestion,
    spatialRelations: intent.relations || [],
    feedbackDraft: group.feedbackDraft || (!sameAction ? group.replacementText : '') || '',
    replacementText: sameAction ? group.replacementText || '' : '',
  })
  toast(group.targets.length - patch.targets.length > 1 ? '已取消该组件及与它重叠的父子选区' : '已取消选中，网页内容未改变')
  scheduleAnalysis()
}

function syncPaintMarksFromGroup(group) {
  const currentMarks = group?.strokes || []
  setPaintMarks(currentMarks.map((stroke) => ({
    points: (stroke.points || []).map((point) => ({ x: point.x, y: point.y })),
    coordinateSpace: group.coordinateSpace || 'web-document',
    color: stroke.color || SELECT_COLOR,
    width: stroke.width, opacity: stroke.opacity, smoothing: stroke.smoothing,
    role: stroke.role || 'select',
    shape: stroke.shape || '',
    fingerprint: stroke.fingerprint || '',
    closed: Boolean(stroke.closed),
    id: stroke.id,
    revision: stroke.revision || 0,
  })))
}

function renderHistory() {
  const edits = listWebEdits()
  const active = edits.filter((edit) => edit.keep !== false)
  const undone = edits.filter((edit) => edit.keep === false)
  els.historyCount.textContent = String(active.length)
  els.historyList.replaceChildren()
  if (!edits.length) {
    const empty = document.createElement('li')
    empty.className = 'history-empty'
    empty.textContent = '还没有修改记录'
    els.historyList.append(empty)
  }
  for (const edit of edits) {
    const li = document.createElement('li')
    li.className = edit.keep === false ? 'is-undone' : ''
    const label = document.createElement('span')
    label.textContent = edit.label
    const time = document.createElement('time')
    time.textContent = edit.keep === false ? '已撤销' : '已完成'
    const marker = document.createElement('span')
    marker.className = 'history-marker'
    li.append(marker, label, time)
    els.historyList.append(li)
  }
  els.undo.disabled = active.length === 0
  els.redo.disabled = undone.length === 0
}

function renderPreferences() {
  const state = getBrushState()
  const preferences = state.preferences || { recording: true, items: [] }
  const memory = getBehaviorMemory()
  const profile = getEffectiveBehaviorProfile()
  if (els.preferenceRecording) els.preferenceRecording.checked = memory.learningEnabled !== false
  if (els.preferenceStatus) {
    els.preferenceStatus.textContent = memory.learningEnabled === false ? '未学习' : '自动学习中'
    els.preferenceStatus.classList.toggle('is-off', memory.learningEnabled === false)
  }
  if (els.behaviorClearAction) els.behaviorClearAction.value = profile.clearIntentAction
  if (els.behaviorAmbiguousMode) els.behaviorAmbiguousMode.value = profile.ambiguousMode
  if (els.behaviorTextScope) els.behaviorTextScope.value = profile.textScope
  if (els.behaviorEditStyle) els.behaviorEditStyle.value = profile.editStyle
  if (!els.preferenceList) return
  els.preferenceList.replaceChildren()
  const explicitItems = (preferences.items || []).map((item) => ({
    id: item.id,
    text: item.text,
    meta: '你明确记录的偏好',
    removable: false,
  }))
  const learnedItems = (memory.memories || [])
    .filter((item) => item.key !== 'user.instruction' && item.status !== 'dismissed')
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      text: item.label || item.value,
      meta: item.source === 'observed' ? `自动学习 · ${item.supportCount || 1} 次成功操作` : '已记录',
      removable: true,
    }))
  const items = [...explicitItems, ...learnedItems]
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'preference-empty'
    empty.textContent = memory.learningEnabled === false ? '自动学习已关闭' : '还没有已记录的偏好'
    els.preferenceList.append(empty)
    return
  }
  for (const item of items.slice(0, 8)) {
    const row = document.createElement('div')
    row.className = 'preference-item'
    const text = document.createElement('span')
    text.textContent = item.text
    row.append(text)
    const meta = document.createElement('small')
    meta.textContent = item.meta
    row.append(meta)
    if (item.removable) {
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'preference-remove'
      remove.textContent = '×'
      remove.title = '删除这条学习记录'
      remove.setAttribute('aria-label', `删除偏好：${item.text}`)
      remove.addEventListener('click', () => { removeMemory(item.id); toast('已删除这条学习记录') })
      row.append(remove)
    }
    els.preferenceList.append(row)
  }
}

function setPanelView(view) {
  const headings = { home: '记录与偏好', history: '修改历史', preferences: '用户偏好', brush: '画笔设置', models: '模型状态', agent: 'Agent 记录' }
  panelView = Object.hasOwn(headings, view) ? view : 'home'
  if (els.panel) {
    els.panel.dataset.view = panelView
    els.panel.setAttribute('aria-label', headings[panelView])
  }
  if (els.panelHeading) els.panelHeading.textContent = headings[panelView]
  if (els.history) els.history.hidden = !['home', 'history'].includes(panelView)
  const preferenceSection = document.getElementById('preference-section')
  if (preferenceSection) preferenceSection.hidden = !['home', 'preferences'].includes(panelView)
  document.getElementById('brush-settings-section').hidden = panelView !== 'brush'
  document.getElementById('model-status-section').hidden = panelView !== 'models'
  document.getElementById('agent-record-section').hidden = panelView !== 'agent'
  document.querySelectorAll('[data-panel-target]').forEach((button) => {
    const active = button.dataset.panelTarget === panelView
    button.classList.toggle('is-active', active)
    if (active) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  try { localStorage.setItem('markset-panel-view', panelView) } catch {}
}

function render() {
  // Reproject from original ink, never from the already-scaled last frame.
  // The store, screenshot, proposal and execution stay in the same space.
  const group = getBrushState().group
  if (!strokeActive && group) {
    const reflowed = reflowBrushGroup(group, resolveBrushLayoutRect, refreshBrushTargetGeometry)
    if (reflowed !== group) {
      // A sidebar/window resize changes projection, not user intent. Preserve
      // the semantic revision, running request, clock, draft and pending timer.
      // Incoming plans are reprojected and verified locally before publication.
      patchGroup(reflowed)
      return
    }
  }
  const state = getBrushState()
  const loaded = state.pageLoaded && isWebDocActive()
  syncPaintMarksFromGroup(state.group)
  document.body.classList.toggle('is-armed', state.mode === 'brush')
  els.export.disabled = !loaded
  els.brush.disabled = !loaded || Boolean(state.group?.applying)
  els.brush.setAttribute('aria-pressed', String(state.mode === 'brush'))
  els.brush.classList.toggle('is-on', state.mode === 'brush')
  els.brush.querySelector('.brush-label').textContent = state.mode === 'brush' ? '退出画笔' : '开启画笔'
  els.brush.querySelector('kbd').hidden = state.mode === 'brush'
  els.modePill.textContent = !loaded ? '未导入' : state.mode === 'brush' ? '画笔中' : state.group ? '待确认' : '浏览中'
  els.modePill.className = `status-pill ${state.mode === 'brush' ? 'is-active' : ''}`
  els.empty.hidden = !loaded || state.mode === 'brush' || Boolean(state.group)
  els.brushState.hidden = !loaded || state.mode !== 'brush' || Boolean(state.group)
  els.proposal.hidden = !state.group
  els.page.classList.toggle('is-guide', !loaded)
  if (state.group) {
    const group = state.group
    const intent = group.inferredIntent
    els.analysis.textContent = group.modelPending || group.status === 'analyzing' ? 'AI 正在分析…' : group.analysisIssue ? group.analysisIssue.message : group.status === 'previewing' ? '预览中' : intent?.needsClarification ? '需要你确认' : group.modelError ? '分析未完成' : intent?.source === 'local-fallback' ? '本地方案' : '待你确认'
    els.proposalText.textContent = intent ? proposalHeadline(intent, group) : '正在理解这组笔迹…'
    els.proposalConfidence.textContent = intent
      ? `${confidenceLabel(intent.confidence)} · ${group.strokes.length} 笔 · ${group.targets.length} 个对象${group.model?.name ? ` · ${group.model.name}` : ''}`
      : ''
    els.hint.textContent = intent?.hint || '停笔约 1 秒后生成建议。'
    const choices = intentChoices(intent)
    const needsChoices = getEffectiveBehaviorProfile().ambiguousMode !== 'input' && !intent?.clarificationAlreadyAnswered && !clarificationNeedsContent(intent) && choices.length > 0 && (intent?.type === 'note' || intent?.needsClarification || (intent?.suggestion?.alternatives || []).some((item) => !isAnnotationChoice(item)))
    els.proposalAlternatives.hidden = Boolean(group.modelPending || group.modelError || group.intentLocked || !choices.length || !needsChoices)
    els.proposalAlternatives.replaceChildren()
    for (const alternative of choices) {
      const recommended = alternative === recommendedChoice(intent, choices)
      const button = document.createElement('button')
      button.type = 'button'; button.className = `alternative-button${recommended ? ' is-recommended' : ''}`; button.textContent = `${recommended ? '推荐 · ' : ''}${alternative}`
      button.addEventListener('click', () => {
        if (intent?.needsClarification || intent?.type === 'note') {
          patchGroup({ selectedAlternative: alternative })
          render()
        } else selectIntentAlternative(alternative, intent)
      })
      els.proposalAlternatives.append(button)
    }
    const needsInput = Boolean(intent?.needsInput || clarificationNeedsContent(intent))
    els.replaceEditor.hidden = Boolean(group.modelError || !needsInput)
    els.replaceInput.value = group.replacementText || ''
    els.proposalActions.hidden = Boolean(group.modelError || !intent || intent.type === 'note')
    els.layoutPreview.disabled = !intent || group.status === 'analyzing'
    els.apply.disabled = !group.preview || group.status !== 'previewing'
    els.preview.hidden = Boolean(group.modelError)
    els.layoutPreview.hidden = Boolean(group.modelError || intent?.type !== 'reorder')
    els.preview.textContent = intent?.type === 'replace-image' ? '预览替换图片' : intent?.type === 'delete' ? '预览移除结果' : '生成预览'
    els.keepDrawing.hidden = group.status === 'previewing'
    if (!strokeActive && group.status !== 'draft') renderGhost(group)
    else els.ghost.replaceChildren()
  } else els.ghost.replaceChildren()
  renderInlineProposal(state.group)
  renderTargetControls(state.group)
  renderRegionNumbers(state.group)
  renderHistory()
  renderPreferences()
}
function hasWebDocumentFrame() {
  return Boolean(document.getElementById('web-doc-frame')?.contentDocument)
}

function toBrushCoordinate(point) {
  return hasWebDocumentFrame() ? screenToWebDocumentPoint(point) : { ...point }
}

function createGroup(stroke) {
  return {
    id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    revision: 1,
    coordinateSpace: hasWebDocumentFrame() ? 'web-document' : 'viewport',
    strokes: [stroke], targets: [], excludedTargetIds: [],
    spatialRelations: [], inferredIntent: null, suggestion: null, preview: null, status: 'draft', replacementText: '', customInstruction: '', userInstruction: '', feedbackDraft: '', selectedAlternative: '', answeredClarifications: [], localIntent: null, modelPending: false, modelError: '', analysisIssue: null, intentLocked: false,
  }
}
function mergeTargets(existing, hits, { expandPeers = false } = {}) {
  const next=mergeHitTargets(existing,[...(hits?.texts?.found || []),...(hits?.images?.found || [])])
  return expandPeers ? expandBrushTargets(next, { includePeers: true, max: 8 }) : next
}
function modelIntentIsUsable(intent, localIntent, userInstruction = '', availableTargets = localIntent?.targets || []) {
  return !modelIntentRejectionReason(intent,localIntent,userInstruction,availableTargets)
}

function modelIntentRejectionReason(intent, localIntent, userInstruction = '', availableTargets = localIntent?.targets || []) {
  if (!intent) return 'missing-plan'
  const checked = validateIntentPlan(intent, availableTargets, userInstruction)
  if (!checked.ok) return checked.reason
  // Geometry alone never authorizes a local deletion. Model proposals use the
  // actual vision evidence and still require the user's explicit Apply click.
  const deleteSteps = (intent.type === 'batch' ? intent.steps || [] : [intent]).filter((step) => step.type === 'delete')
  if (intent.source !== 'model' && deleteSteps.length && !String(userInstruction).trim()) {
    if (!hasDeleteEvidence(localIntent || {}, { localIntent })) return 'selection-alone-does-not-authorize-deletion'
    // A character hit is evidence, not a command to delete only that range.
    // The visual planner may recognize whole-object crossing-out too. It
    // still needs deletion evidence, valid scope and explicit confirmation.
  }
  if (intent.type === 'replace' && intent.replacementText === String(userInstruction).trim() && intent.replacementText) return 'instruction-is-not-literal-replacement-copy'
  return ''
}

function hasDeleteEvidence(intent = {}, group = {}) {
  const evidence = group.localIntent?.parameters || intent.parameters || group.parameters || {}
  return Boolean(
    evidence.hasCross ||
    evidence.textStrike ||
    // A lasso hits character ranges too. Coverage is scope evidence, not a
    // destructive gesture (the root cause of the old circle → delete leak).
    (!evidence.hasRegion && evidence.markedTextRange),
  )
}

function localFallbackIntent(localIntent, group, reason = '') {
  const base = localIntent || analysisRecoveryIntent(group)
  const targets = base.targets?.length ? base.targets : (group?.targets || [])
  const choices = [...new Set((base.suggestion?.alternatives || [])
    .filter((choice) => !isAnnotationChoice(choice)))]
  const hasText = targets.some((target) => target.kind === 'text')
  const hasImage = targets.some((target) => target.kind === 'image')
  const hasArrow = Boolean(base.parameters?.hasArrow)
  const fallbackChoices = []
  if (choices.length) fallbackChoices.push(...choices)
  if (!fallbackChoices.length && hasArrow && targets.length > 1) fallbackChoices.push('重新排列这些对象')
  // A target hit is not a delete command. Destructive choices may only be
  // exposed when the local interpretation contains explicit deletion
  // evidence (cross, strike-through, or a marked character range).
  const canDelete = hasDeleteEvidence(base, group)
  if (!fallbackChoices.length && hasImage) fallbackChoices.push('替换图片')
  if (!fallbackChoices.length && hasText) fallbackChoices.push('调整颜色', '在标记对象旁添加内容', ...(targets.length > 1 ? ['重新排列这些对象'] : []))
  if (canDelete) fallbackChoices.push('移除所选内容')
  if (!fallbackChoices.length && targets.length) fallbackChoices.push('修改这些内容')
  const uniqueChoices = [...new Set(fallbackChoices.filter(Boolean))].slice(0, 3)
  const isActionable = base.type && base.type !== 'note'
  if (isActionable) {
    return {
      ...base,
      confidence: Math.max(0.7, Number(base.confidence) || 0),
      source: 'local-fallback',
      hint: '已根据笔迹和页面对象形成本地修改方案；你确认后才会改变网页。',
    }
  }
  return {
    ...base,
    type: 'note',
    operation: 'note',
    confidence: Math.max(0.62, Number(base.confidence) || 0),
    needsClarification: false,
    needsInput: false,
    clarificationAlreadyAnswered: false,
    clarifyingQuestion: '',
    targets,
    suggestion: {
      text: targets.length ? '已识别标记对象，请选择一种修改方式' : '已识别修改区域，请补充要添加的内容',
      alternatives: uniqueChoices,
    },
    hint: reason || '已保留多种具体修改方向；请选择其一，或在输入框中补充要求。',
    source: 'local-fallback',
  }
}

async function askModelToInterpret(group, localIntent, userInstruction = '', { pauseMs = 0 } = {}) {
  const analysisStarted = performance.now()
  const timings = { pauseMs, observationMs: 0, captureMs: 0, planMs: 0, verifyMs: 0, repairMs: 0 }
  let flowRetriesUsed = 0
  const requestId = ++modelRequestSeq
  const explicitReplacement = hasBrushRegionReference(userInstruction) ? null : parseExplicitTextReplacement(userInstruction, group.targets || [])
  const explicitIntent = explicitReplacement ? {
    ...localIntent, type: 'replace', operation: 'replace_text', targets: explicitReplacement.targets,
    targetText: explicitReplacement.targetText, replacementText: explicitReplacement.replacementText,
    targetRanges: explicitReplacement.targetRanges, needsInput: false, confidence: 0.99, source: 'user_instruction',
    goal: `将“${explicitReplacement.targetText}”改为“${explicitReplacement.replacementText}”`, rationale: '用户明确指定了原文和替换内容，且页面中只有一个精确匹配。', strategy: '仅替换唯一匹配的文本片段，保留其余节点、内容和样式。', constraints: ['不改动匹配范围之外的内容'], impact: { scope: '一个文本片段', riskLevel: 'low' },
    suggestion: { text: `将“${explicitReplacement.targetText}”替换为“${explicitReplacement.replacementText}”`, alternatives: [] },
    hint: '已按你明确给出的原文和新文案定位；只替换唯一匹配片段，确认前不会改动网页。',
  } : null
  modelAbortController?.abort()
  if (activeJournalId) agentJournal.cancel(activeJournalId)
  // The actual routed model is only known when the server replies; never label
  // a failed Max request with the configured Flash default.
  const journalId = agentJournal.begin(group, { instruction: userInstruction, localIntent })
  activeJournalId = journalId
  let journalFinished = false
  const recordResult = (details) => {
    journalFinished = true
    agentJournal.finish(journalId, { ...details, timings: { ...timings, totalMs: Math.round(performance.now() - analysisStarted + pauseMs) } })
  }
  const requestController = new AbortController()
  modelAbortController = requestController
  const progressStarted = Date.now()
  const updateProgress = value => {
    const current = getBrushState().group
    if (requestController.signal.aborted || requestId !== modelRequestSeq || strokeActive
      || current?.id !== group.id || current?.revision !== group.revision || current.intentLocked) return
    patchGroupAnalysis(group, { analysisProgress: { ...current.analysisProgress, ...value, startedAt:progressStarted } })
  }
  const observeStarted = performance.now()
  let planningGroup = group
  let observation = observeBrushPage(group)
  let availableTargets = excludeBrushTargets(planningTargets(group.targets,observation),group.excludedTargetIds || [])
  const allowedIds = new Set(availableTargets.map((target)=>String(target.webId)))
  let safeObservation = observation ? { ...observation,nodes:observation.nodes.filter((node)=>allowedIds.has(String(node.webId))) } : null
  timings.observationMs = Math.round(performance.now() - observeStarted)
  if (explicitIntent && modelIntentIsUsable(explicitIntent, localIntent, userInstruction)) {
    // A unique, exact source → replacement is already a complete local plan;
    // do not make this deterministic edit depend on the vision-model gateway.
    patchGroupAnalysis(group, {
      inferredIntent: explicitIntent,
      suggestion: explicitIntent.suggestion,
      replacementText: explicitIntent.replacementText,
      model: null,
      modelPending: false,
      modelError: '', analysisIssue: null,
      status: 'suggested',
    })
    render()
    recordResult({ intent: explicitIntent, source: 'local' })
    activeJournalId = null
    modelAbortController = null
    return
  }
  try {
    patchGroupAnalysis(group, { modelPending: true, analysisPaused:false, analysisProgress:{ stage:'preparing', startedAt:progressStarted, draftSummary:'' } })
    const data = await runAnalysisTask(async (signal) => {
      const { captureAnnotationScene } = await import('./capture.js')
      let regions
      const captureStarted = performance.now()
      let scene
      try { scene = await runAnalysisTask(async (captureSignal) => {
        // A resize during evidence preparation may invalidate the cached pixels.
        // Retry LOCAL capture once within the same deadline, never the model.
        for (let capturePass=0; capturePass<2; capturePass++) {
          captureSignal.throwIfAborted()
          const current = getBrushState().group
          if (!current || current.id !== group.id || current.revision !== group.revision) throw new DOMException('Analysis superseded','AbortError')
          planningGroup = reflowBrushGroup({...group,localIntent},resolveBrushLayoutRect,refreshBrushTargetGeometry)
          regions = numberedBrushRegions(planningGroup)
          const observeStarted = performance.now()
          observation = observeBrushPage(planningGroup)
          availableTargets = excludeBrushTargets(planningTargets(planningGroup.targets,observation),group.excludedTargetIds || [])
          const allowed = new Set(availableTargets.map(target=>String(target.webId)))
          safeObservation = observation ? {...observation,nodes:observation.nodes.filter(node=>allowed.has(String(node.webId)))} : null
          timings.observationMs += Math.round(performance.now()-observeStarted)
          try { return await captureAnnotationScene(editor,{regions,mode:'planner',signal:captureSignal}) }
          catch(error) { if (capturePass || error.code !== 'capture_page_changed') throw error }
        }
      }, { signal, timeoutMs: 8_000, timeoutPhase:'capture' }) }
      finally { timings.captureMs = Math.round(performance.now() - captureStarted) }
      Object.assign(timings, scene.captureMetrics || {})
      signal.throwIfAborted()
      if (requestId !== modelRequestSeq || strokeActive) throw new DOMException('Analysis superseded', 'AbortError')
      const payload = {
        // Capture contains a full-document thumbnail and a cropped close-up,
        // not a viewport screenshot. Send both spaces; the server uses stable
        // document coordinates for geometric evidence and edit planning.
        strokes: planningGroup.strokes.map(({ layoutAnchor, ...stroke }) => ({
          ...stroke,
          points: (stroke.points || []).map(webDocumentToScreenPoint),
          documentPoints: stroke.points || [],
        })),
        targets: planningGroup.targets.map((target) => {
          const screenRect = liveScreenRect(target) || target.screenRect || target.imageRect || null
          return {
            ...target,
            screenRect,
            documentRect: screenRect ? screenToWebDocumentRect(screenRect) : target.documentRect || null,
          }
        }),
        regions,
        pageText: scene.pageText || '',
        // The composite page already contains the ink. Add only the relevant
        // close-up so the vision request stays fast and within gateway limits.
        imageDataUrls: [scene.combinedDataUrl, scene.closeupDataUrl].filter(Boolean),
        localInterpretation: planningGroup.localIntent || localIntent,
        userInstruction,
        evidence: localIntent?.evidence || null,
        observation:safeObservation,
        answeredClarifications:group.answeredClarifications || [],
        preferences: getBrushState().preferences?.recording === false ? [] : (getBrushState().preferences?.items || []).map((item) => item.text).slice(0, 8),
        behaviorMemory: getAgentBehaviorContext({
          operation: localIntent?.type || '',
          targetKinds: group.targets.map((target) => target.kind),
        }),
      }
      const addServerMetrics = (metrics = {}) => {
        metrics ||= {}
        const requestOffset = timings.modelRequests || 0
        if (Array.isArray(metrics.attempts)) timings.attempts = sanitizeModelAttempts([
          ...(timings.attempts || []), ...sanitizeModelAttempts(metrics.attempts).map(attempt => ({
            ...attempt, request: (attempt.request || 1) + requestOffset,
          })),
        ])
        for (const key of ['modelRequests', 'modelAttempts', 'upstreamMs', 'serverMs', 'readToolCalls']) timings[key] = (timings[key] || 0) + (Number(metrics[key]) || 0)
        for (const key of ['evidenceChars','originalEvidenceChars','completedPlanMs']) if (Number.isFinite(metrics[key])) timings[key]=metrics[key]
      }
      const requestPlan = async (body, stage) => {
        const started = performance.now()
        updateProgress({stage:'planning',draftSummary:''})
        try { const result = await planBrushIntent(body, { signal, onProgress:value=>{
          // Ignore legacy partial drafts. Only publish a complete checked plan.
          if (value.stage !== 'draft') updateProgress({...value,draftSummary:''})
        } }); addServerMetrics(result.timings); return result }
        catch (error) { addServerMetrics(error.timings); throw error }
        finally { timings[stage] += Math.round(performance.now() - started) }
      }
      const result = await requestPlan(payload, 'planMs')
      const retriesUsed = Number(result.retriesUsed) || 0
      flowRetriesUsed = retriesUsed
      const trace = result.trace || []
      signal.throwIfAborted()
      updateProgress({stage:'verify',draftSummary:''})
      const verifyStarted = performance.now()
      let report, verificationElapsed
      let verified
      try {
        verified = await verifyReflowedBrushPlan(planningGroup,result.intent,{
          resolveRect:resolveBrushLayoutRect,refreshTarget:refreshBrushTargetGeometry,signal,
          verify:async(plan,strokes)=>{
            const checked = validateIntentPlan(plan,availableTargets,userInstruction)
            const rejection = modelIntentRejectionReason(plan,localIntent,userInstruction,availableTargets)
            let report = rejection ? planCheckReport([{code:rejection}]) : { ok:true,checks:['schema','scope'] }
            if (report.ok && checked.actionable && !plan.needsInput && !plan.needsClarification) {
              const trial = await runAnalysisTask((checkSignal)=>verifyBrushPlan(plan,strokes,{signal:checkSignal}),{signal,timeoutMs:4_000,timeoutPhase:'verify'})
              report = planCheckReport(trial.issues || [],trial)
            }
            if (report.ok && plan.candidatePlans?.length) {
              const candidateWarnings = []
              for (const [index,candidate] of plan.candidatePlans.entries()) {
                const trial=await runAnalysisTask((checkSignal)=>verifyBrushPlan(candidate,strokes,{signal:checkSignal}),{signal,timeoutMs:4_000,timeoutPhase:'verify'})
                const candidateReport=planCheckReport(trial.issues || [],trial)
                if (!candidateReport.ok) { report={...candidateReport,issues:candidateReport.issues.map(issue=>({...issue,candidateIndex:index}))}; break }
                candidateWarnings.push(...(candidateReport.warnings || []).map(issue=>({...issue,candidateIndex:index})))
              }
              if (report.ok) report=planCheckReport(candidateWarnings,{checks:['execution','scope','candidate-execution','undo']})
            }
            return report
          }
        })
        report = verified.report
      } finally {
        verificationElapsed = Math.round(performance.now() - verifyStarted)
        timings.verifyMs += verificationElapsed
      }
      if (report.ok) return { ...result,intent:verified.plan,retriesUsed,repairsUsed:0,observation:safeObservation,validation:report,trace:[...trace,{stage:'verify',elapsedMs:verificationElapsed,summary:report.checks?.includes('execution') ? `结构、影响范围与隔离执行检查通过${report.warnings?.length ? `；${report.warnings.length} 项提醒，不阻断` : ''}` : '目标与引用检查通过；尚未执行验证'}] }
      // Stop after the first proposal. Preserve it for display/diagnostics;
      // do not send the trial failure back to the model or rewrite the goal.
      throw Object.assign(new Error('方案未通过隔离执行校验'),{code:'agent_plan_invalid',status:422,model:result.model,routing:result.routing,
        trace:[...trace,{stage:'verify',summary:'执行校验未通过；未自动修复',issues:report.issues}],validation:report,repairsUsed:0,retriesUsed,intent:result.intent})
    }, { signal: requestController.signal, timeoutMs: BRUSH_MODEL_TIMEOUT_MS })
    const current = getBrushState().group
    if (!current || current.id !== group.id || current.revision !== group.revision || strokeActive || requestId !== modelRequestSeq || current.intentLocked) return
    // Flush geometry before publishing the already-reprojected result, so a
    // pending ResizeObserver notification cannot scale its coordinates twice.
    const currentGeometry = reflowBrushGroup(current,resolveBrushLayoutRect,refreshBrushTargetGeometry)
    if (currentGeometry !== current) patchGroup(currentGeometry)
    let resolvedIntent = explicitIntent || data.intent
    if (!modelIntentIsUsable(resolvedIntent, localIntent, userInstruction,availableTargets)) {
      // Defensive final gate. Reject visibly; never silently turn an Agent
      // design into a local action or an unrelated correction question.
      const fallback = { type:'note',operation:'note',goal:'这次修改方案未通过校验',source:'model',needsInput:false,needsClarification:false,suggestion:{text:'这次方案未能执行，可调整要求或重试。',alternatives:[]} }
      const issue = analysisIssue({ code: 'model_invalid_plan' })
      const published = patchGroupAnalysis(group, { inferredIntent: fallback, suggestion: fallback.suggestion, status: 'suggested', model: null, modelPending: false, modelError: '', analysisIssue: issue })
      if (published) recordResult({ intent: fallback, modelIntent: data.intent, model: data.model, routing: data.routing, retriesUsed: data.retriesUsed, rejectionReason: modelIntentRejectionReason(data.intent,localIntent,userInstruction,availableTargets), issue, rejected: true, source: 'ai' })
      if (published) toast(`${issue.message}；网页未修改`)
      render()
      return
    }
    // Keep deterministic choices when a compatible vision model returns a
    // valid but underspecified note. The model may improve wording while
    // omitting alternatives; the local interpreter still knows which edits
    // are plausible for this exact mark and target set.
    if (resolvedIntent.source !== 'model' && (resolvedIntent.type === 'note' || resolvedIntent.needsClarification)
      && !(resolvedIntent.suggestion?.alternatives || []).some((item) => !isAnnotationChoice(item))) {
      const localAlternatives = (localIntent?.suggestion?.alternatives || [])
        .filter((item) => !isAnnotationChoice(item))
        .slice(0, 3)
      if (localAlternatives.length) {
        resolvedIntent = {
          ...resolvedIntent,
          suggestion: { ...(resolvedIntent.suggestion || {}), alternatives: localAlternatives },
        }
      }
    }
    patchGroupAnalysis(group, {
      inferredIntent: resolvedIntent,
      observation:data.observation,
      validation:data.validation,
      planRepairsUsed:data.repairsUsed || 0,
      analysisRetriesUsed:data.retriesUsed || 0,
      // Background analysis must not erase a correction typed while waiting.
      feedbackDraft:current.feedbackDraft !== group.feedbackDraft
        || current.feedbackDraft && !userInstruction.includes(current.feedbackDraft)
        ? current.feedbackDraft || '' : '',
      suggestion: resolvedIntent.suggestion,
      spatialRelations: resolvedIntent.relations || [],
      replacementText: resolvedIntent.type === 'replace' ? (resolvedIntent.replacementText || '') : getBrushState().group?.replacementText || '',
      model: explicitIntent ? null : { name: data.model, confidence: resolvedIntent.confidence },
      modelPending: false,
      analysisIssue: null,
      status: 'suggested',
    })
    recordResult({ intent: resolvedIntent, modelIntent: data.intent, model: data.model, routing: data.routing, retriesUsed: data.retriesUsed,repairsUsed:data.repairsUsed, trace:data.trace,validation:data.validation, source: 'ai' })
    render()
  } catch (error) {
    if (error?.name === 'AbortError') return
    error.repairsUsed = 0
    error.retriesUsed=Math.max(flowRetriesUsed,Number(error.retriesUsed) || 0)
    // Keep deterministic geometry usable when the gateway is unavailable. The
    // model improves ranking and wording; it is not required for basic marks.
    console.debug('[markset brush] model fallback', error?.message || error)
    const current = getBrushState().group
    if (current?.id === group.id && requestId === modelRequestSeq) {
      const safeIntent = error.code === 'agent_plan_invalid' || error.code === 'agent_tool_limit'
        ? error.intent || {type:'note',operation:'note',goal:'方案未完成',source:'model',needsInput:false,needsClarification:false,suggestion:{text:error.proposalSummary || '这次方案格式或安全执行检查未通过；未自动修复。',alternatives:[]}}
        : explicitIntent || localFallbackIntent(localIntent, group, '模型暂时不可用，已使用本地识别出的修改方向。')
      const issue = analysisIssue(error)
      const published = patchGroupAnalysis(group, { inferredIntent: safeIntent, suggestion: safeIntent.suggestion, replacementText: explicitIntent?.replacementText || '', status: 'suggested', model: null, modelPending: false, modelError: '', analysisIssue: issue,planRepairsUsed:error.repairsUsed || 0,analysisRetriesUsed:error.retriesUsed || 0 })
      if (published) recordResult({ intent: safeIntent, modelIntent:error.intent,issue, source: safeIntent.source === 'model' ? 'ai' : 'fallback', model: error.model || '', routing: error.routing, retriesUsed: error.retriesUsed,repairsUsed:0,trace:error.trace,validation:error.validation })
      if (published) toast(`${issue.message}；网页未修改`)
      render()
    }
  } finally {
    if (!journalFinished) agentJournal.cancel(journalId)
    if (activeJournalId === journalId) activeJournalId = null
    if (requestId === modelRequestSeq) modelAbortController = null
  }
}

function cancelModelAnalysis() {
  stopAnalysisClock()
  modelRequestSeq += 1
  modelAbortController?.abort()
  modelAbortController = null
  if (activeJournalId) agentJournal.cancel(activeJournalId)
  activeJournalId = null
}

function recordLocalDecision(group, intent, instruction = '', issue = null) {
  const id = agentJournal.begin(group, { instruction, localIntent: intent })
  agentJournal.finish(id, { intent, source: issue ? 'fallback' : 'local', issue })
}

function analyzeCurrentGroup({ pauseMs = 0 } = {}) {
  clearTimeout(analysisTimer)
  try {
    const group = getBrushState().group
    if (!group || strokeActive || group.applying) return
    const snapshot = structuredClone(group)
    const interpreted = interpretSelectedTargets(snapshot)
    patchGroup({
      inferredIntent: interpreted,
      suggestion: interpreted.suggestion,
      spatialRelations: interpreted.relations || [],
      localIntent: interpreted,
      status: 'suggested',
      modelPending: true,
      analysisPaused:false, analysisProgress:{stage:'preparing',startedAt:Date.now(),draftSummary:''},
      model: null,
      modelError: '', analysisIssue: null,
    })
    render()
    // Model analysis uses an immutable snapshot. New strokes cancel this
    // request and schedule a fresh interpretation for the expanded group.
    void askModelToInterpret({ ...snapshot, localIntent: interpreted }, interpreted, snapshot.customInstruction || snapshot.userInstruction || '',
      { pauseMs }).catch((error) => {
      console.debug('[markset brush] analysis request failed', error?.message || error)
    })
  } catch (error) {
    // Geometry/capture failures must not leave the brush in a silent state.
    // Keep the mark visible and expose a local, non-destructive next step.
    console.debug('[markset brush] local analysis failed', error?.message || error)
    const group = getBrushState().group
    if (!group) return
    const fallback = analysisRecoveryIntent(group)
    recordLocalDecision(group, fallback, '', analysisIssue(error))
    patchGroup({ inferredIntent: fallback, suggestion: fallback.suggestion, localIntent: fallback, status: 'suggested', modelPending: false, modelError: '', analysisIssue: analysisIssue(error) })
    toast('这次识别未完成，笔迹已保留，可以重试')
    render()
  }
}
function scheduleAnalysis() {
  clearTimeout(analysisTimer)
  if (!getBrushSettings().autoAnalyze) return render()
  const started = performance.now()
  analysisTimer = setTimeout(() => analyzeCurrentGroup({ pauseMs: Math.round(performance.now() - started) }), getBrushSettings().analysisDelayMs)
}
function analyzeMarkedGroup() {
  const group = getBrushState().group
  if (!group || strokeActive || group.applying || group.status === 'analyzing' || group.modelPending) return
  if (String(group.feedbackDraft || '').trim()) return void interpretCustomIntent('analyze')
  analyzeCurrentGroup()
}
function onStrokeStarted() {
  strokeActive = true
  scheduleEvidenceWarmup()
  clearTimeout(analysisTimer)
  cancelModelAnalysis()
  // Suspend old suggestions at pointerdown, not at pointerup. No analysis
  // card may appear underneath the pointer while the user is still drawing.
  els.inlineProposal.hidden = true
  els.ghost.replaceChildren()
  $('target-controls-layer').replaceChildren()
  $('region-labels-layer').replaceChildren()
}
function onStrokeFinished(polygon, meta) {
  strokeActive = false
  cancelModelAnalysis()
  const current = getBrushState().group
  const newGroup = !current || current.status === 'applied'
  const revision = newGroup ? 1 : (current.revision || 0) + 1
  const stroke = {
    id: meta.strokeId, revision, points: meta.rawPoints.map(toBrushCoordinate),
    polygon, shape: meta.shape === 'dot' ? 'dot' : '', closed: Boolean(meta.closed),
    role: meta.subtract ? 'subtract' : meta.add ? 'add' : 'select', color: meta.strokeColor || SELECT_COLOR,
    width: meta.width, opacity: meta.opacity, smoothing: meta.smoothing,
  }
  // Commit raw ink FIRST. Neither hit testing, recognition, nor an API result
  // is allowed to decide if a real user stroke is stored.
  if (newGroup) startGroup(createGroup(stroke))
  else patchGroup({
    revision, strokes: [...current.strokes, stroke],
    status: 'draft', preview: null, inferredIntent: null, localIntent: null, suggestion: null, applying: false, imageError: null,
    replacementText: '', customInstruction: current.customInstruction || '', userInstruction: current.userInstruction || '', feedbackDraft: current.feedbackDraft || '',
    analysisPaused:false, analysisProgress:null,
    selectedAlternative: '', answeredClarifications: [], modelPending: false, modelError: '', analysisIssue: null, intentLocked: false,
  })
  let shape = stroke.shape
  try {
    if (shape !== 'dot') shape = classifyMarkShape([meta.rawPoints]).shape || classifyStrokeShape(meta.rawPoints) || ''
  } catch (error) {
    console.debug('[markset brush] classification failed; continuing target hit test', error)
  }
  try {
    const hits = isWebDocActive() ? hitWebDoc(polygon, { loose: true }) : null
    const group = getBrushState().group
    let anchoredStroke = { ...stroke, shape, hitTargetIds: [...(hits?.texts?.found || []), ...(hits?.images?.found || [])].map(target => String(target.webId)) }
    try {
      anchoredStroke = attachBrushLayoutAnchor(anchoredStroke, [...(hits?.texts?.found || []), ...(hits?.images?.found || [])]) || anchoredStroke
    } catch (error) { console.debug('[markset brush] layout anchor unavailable; ink and hits retained', error) }
    patchGroup({
      strokes: group.strokes.map((item) => item.id === stroke.id ? anchoredStroke : item),
      targets: excludeBrushTargets(mergeTargets(group.targets, hits || {}, { expandPeers: shape === 'arrow' }), group.excludedTargetIds || []),
    })
  } catch (error) {
    console.debug('[markset brush] stroke enrichment failed; raw ink retained', error)
  }
  scheduleAnalysis()
  scheduleEvidenceWarmup()
  return { paintOwned: true, strokeId: stroke.id }
}
function toggleBrush(next) {
  if (getBrushState().group?.applying) return toast('图片任务进行中；取消当前修改后可继续画')
  const state = getBrushState(); const mode = typeof next === 'boolean' ? (next ? 'brush' : 'browse') : state.mode === 'brush' ? 'browse' : 'brush'
  if (mode === 'brush' && !state.pageLoaded) return toast('请先导入一个 HTML 网页')
  if (mode === 'browse') disarmDrawing(); else setLassoMode(true)
  patchBrush({ mode }); render()
}
function clearCurrentGroup() {
  cancelEvidenceWarmup()
  // Clearing a suggestion/annotation is not leaving the user's drawing mode.
  // Interrupt any active contact before resetting, then restore input mode.
  disarmDrawing()
  strokeActive = false
  cancelModelAnalysis()
  clearTimeout(analysisTimer); clearPaintMarks(); clearGroup()
  if (getBrushState().mode === 'brush') setLassoMode(true)
  render()
}
function validateCurrentPlan(group, intent = group?.inferredIntent) {
  if (!group || !intent) return { ok: false, reason: 'missing-plan' }
  const candidate = { ...intent, replacementText: group.replacementText || intent.replacementText || '' }
  const instruction = group.customInstruction || group.userInstruction || ''
  // Local heuristics need explicit deletion evidence. A model proposal is not
  // an edit until Apply; its selected targets, ranges and rollback still check.
  const hasDeletion = (candidate.type === 'batch' ? candidate.steps || [] : [candidate]).some((step) => step.type === 'delete')
  if (candidate.source !== 'model' && hasDeletion && !String(instruction).trim()
    && !hasDeleteEvidence(candidate, group)) {
    return { ok: false, reason: 'delete-needs-explicit-mark' }
  }
  return validateIntentPlan(candidate, excludeBrushTargets(planningTargets(group.targets || [], group.observation), group.excludedTargetIds || []), group.customInstruction || group.userInstruction || '')
}

function explicitlyRequestsMarkedText(instruction) {
  const text = String(instruction || '').trim()
  if (!text) return false
  return /(?:只|仅|这(?:些|两个|几个)?|被|所)?(?:笔迹|画线|划过|圈住|标记|叉掉|删掉).{0,12}(?:字|词|文字|片段)|(?:局部|部分|这几个字|这两个词|标记范围)/u.test(text)
}

function applyTextScopePreference(group, intent) {
  if (!intent || !['replace', 'delete'].includes(intent.type)) return intent
  // Preferences guide planning, not a second executor rewriting an approved
  // design. In particular, never broaden a model's precise character ranges.
  if (intent.source === 'model') return intent
  if (intent.parameters?.deletionScope) return intent
  if (getEffectiveBehaviorProfile().textScope !== 'text-object') return intent
  if (!Array.isArray(intent.targetRanges) || !intent.targetRanges.length) return intent

  // A current, explicit request such as “删掉这两个词” is stronger than a
  // long-term preference. Only broaden an unqualified mark to its text object.
  const instruction = group.customInstruction || group.userInstruction || ''
  if (explicitlyRequestsMarkedText(instruction)) return intent

  const targets = intent.targets?.length ? intent.targets : group.targets || []
  if (intent.type === 'replace') {
    const textTargets = targets.filter((target) => target?.kind === 'text' && !target.textTruncated)
    if (textTargets.length !== 1) return intent
    const targetText = String(textTargets[0].text || '')
    if (!targetText) return intent
    return { ...intent, targetText, targetRanges: [] }
  }
  return { ...intent, targetRanges: [] }
}

function prepareProposal(group, intent) {
  let next = { ...intent, replacementText: group.replacementText || intent.replacementText || '' }
  let instruction = group.customInstruction || group.userInstruction || ''
  if (intent.type === 'replace') {
    const entered = (els.inlineInput.value || els.replaceInput.value || '').trim()
    const explicit = parseExplicitTextReplacement(entered, group.targets || [])
    if (explicit) {
      next = { ...next, ...explicit, type: 'replace', operation: 'replace', needsInput: false }
    } else {
      next.replacementText = entered || next.replacementText
    }
    if (!next.targetText && !next.targetRanges?.length) return { ok: false, message: '告诉我“把哪段改成什么”，或先把笔迹落在要替换的文字上。' }
  }
  if (intent.type === 'color') {
    const entered = (els.inlineInput.value || els.replaceInput.value || '').trim()
    if (entered) {
      next = {
        ...next,
        replacementText: entered,
        color: entered,
        parameters: { ...(next.parameters || {}), color: entered },
        needsInput: false,
      }
    }
  }
  next = applyTextScopePreference(group, next)
  if (['replace', 'replace-image', 'insert'].includes(next.type) && !String(next.replacementText || '').trim() && !next.imagePrompt && !next.nodes?.length) {
    return { ok: false, message: next.type === 'replace-image' ? '先填图片链接或选择图片。' : '先写入要添加的内容。' }
  }
  const checked = validateCurrentPlan(group,next)
  if (!checked.ok || !checked.actionable) return { ok: false, message: next.clarifyingQuestion || '还缺少修改对象或具体内容，网页没有改变。' }
  if (next.type === 'replace') {
    const dryRun = applyBrushTextReplacement(next.targets?.length ? next.targets : group.targets, { targetText: next.targetText, targetRanges: next.targetRanges, replacementText: next.replacementText }, { dryRun: true })
    if (!dryRun?.ok) return { ok: false, message: dryRun?.reason || '找不到唯一匹配文字，网页没有改变。' }
  }
  return { ok: true, intent: next, instruction }
}

function previewProposal() {
  const group = getBrushState().group; const intent = group?.inferredIntent
  if (!group || !intent) return
  const prepared = prepareProposal(group, intent)
  if (!prepared.ok) return toast(prepared.message)
  const plan = prepared.intent
  if (plan.type === 'reorder') {
    patchGroup({ inferredIntent: plan, preview: { type: 'layout' }, status: 'previewing' })
    render()
    return
  }
  if (plan.type === 'delete') {
    patchGroup({ inferredIntent: plan, preview: { type: 'delete' }, status: 'previewing' })
    render()
    return
  }
  patchGroup({ inferredIntent: plan, replacementText: plan.replacementText, preview: { text: plan.replacementText, targetText: plan.targetText || '' }, status: 'previewing' }); render()
}
async function applyProposal({ direct = false } = {}) {
  const group = getBrushState().group; const intent = group?.inferredIntent
  if (!group || !intent || group.applying || (!direct && !group.preview)) return
  if (group.analysisIssue?.code === 'agent_plan_invalid') return toast(group.analysisIssue.message)
  let result
  const prepared = direct ? prepareProposal(group, intent) : { ok: true, intent }
  if (!prepared.ok) {
    agentJournal.execution(group.id, `未执行：${prepared.message}`, { failed: true })
    return toast(prepared.message)
  }
  const plan = prepared.intent
  const planCheck = validateCurrentPlan(group, plan)
  if (!planCheck.ok || !planCheck.actionable) {
    agentJournal.execution(group.id, '未执行：修改方案尚未通过执行校验', { failed: true })
    return toast(plan.clarifyingQuestion || '这次修改还不够明确，网页没有改变。')
  }
  const targets = plan.targets?.length ? plan.targets : group.targets
  const imageExecution = []
  const imageSteps = (plan.type === 'batch' ? plan.steps : [plan]).filter((step) => step.imagePrompt && (step.type === 'replace-image' || step.type === 'insert' && step.contentKind === 'image'))
  if (imageSteps.length) {
    const imageStartedAt = Date.now()
    disarmDrawing()
    patchGroup({ applying: true, imageError: null }); render()
    try {
      for (const [index, step] of imageSteps.entries()) {
        const mode = step.type === 'replace-image' ? step.imageMode || 'edit' : 'generate'
        const original = mode === 'edit' ? brushOriginalImage(step.targets?.find((target) => target.kind === 'image')) : ''
        if (mode === 'edit' && !original) throw new Error('无法读取原图；没有退化为文字生图，请重新上传原图。')
        const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${mode}:${step.imagePrompt}:${original}`))
        const hash = [...new Uint8Array(fingerprint)].slice(0,10).map((byte) => byte.toString(16).padStart(2,'0')).join('')
        const id = `${group.id}-image-${index}-${hash}`
        const cachedImage = getBrushState().group?.imageAssets?.find(asset=>asset.id===id)
        const generated = cachedImage || await generateImage({ prompt: step.imagePrompt, mode, imageDataUrl: original,
          quality: /高质量|精细文字|复杂版面|精确文字|印刷/u.test(group.customInstruction || group.userInstruction || '') ? 'high' : undefined,
          replaceExisting: mode === 'edit', width: step.parameters?.bounds?.w || 1024, height: step.parameters?.bounds?.h || 1024 }, { requestId: id })
        if (getBrushState().group?.id !== group.id || getBrushState().group?.revision !== group.revision) return
        step.replacementText = generated.imageUrl
        if (!cachedImage) patchGroup({imageAssets:[...(getBrushState().group.imageAssets || []).filter(asset=>asset.id!==id),{id,...generated}].slice(-8)})
        imageExecution.push(`${generated.model}（${mode === 'edit' ? '原图编辑' : '生图'} · ${(generated.elapsedMs / 1000).toFixed(1)} 秒 · 重试 ${generated.retriesUsed || 0} 次）`)
        agentJournal.execution(group.id, `图片已生成：${generated.model} · ${(generated.elapsedMs / 1000).toFixed(1)} 秒；准备应用`)
      }
    } catch (error) {
      if (getBrushState().group?.id === group.id) {
        patchGroup({ applying: false, imageError: { message: error.message, code: error.code || 'image_failed' }, imageTaskId: error.taskId || '' })
        if (getBrushState().mode === 'brush') setLassoMode(true)
        agentJournal.execution(group.id, `图片任务失败：${error.message} · ${((Date.now() - imageStartedAt) / 1000).toFixed(1)} 秒`, { failed: true }); render(); toast(error.message)
      }
      return
    }
    // Generation and trial verification are one applying operation. Do not
    // briefly expose a new analysis/apply action between these stages.
    patchGroup({ imageError: null })
  }
  // An image task can finish after the sidebar/window resized. Its generated
  // asset is still valid, but its insertion bounds must use the current page.
  disarmDrawing()
  patchGroup({applying:true})
  let report, executionGroup, executionPlan
  try {
    const verified = await runAnalysisTask((signal)=>verifyReflowedBrushPlan(group,plan,{
      resolveRect:resolveBrushLayoutRect,refreshTarget:refreshBrushTargetGeometry,signal,
      verify:(candidate,strokes)=>verifyBrushPlan(candidate,strokes,{signal}),
    }),{timeoutMs:4_000,timeoutPhase:'verify'})
    report = planCheckReport(verified.report.issues || [],verified.report); executionGroup = verified.group; executionPlan = verified.plan
  } catch (error) {
    report = {ok:false,issues:[{code:'verification-timeout',detail:'执行检查未完成，原网页和输入已保留'}]}
  }
  const stillCurrent = getBrushState().group
  if (!stillCurrent || stillCurrent.id !== group.id || stillCurrent.revision !== group.revision) return
  if (!report.ok) {
    const issue = analysisIssue({code:'agent_plan_invalid',validation:report,repairsUsed:0})
    patchGroup({applying:false,validation:report,analysisIssue:issue})
    if (getBrushState().mode === 'brush') setLassoMode(true)
    agentJournal.execution(group.id,`修改未应用：${blockingPlanIssues(report).map(planIssueDescription).join('；')}`,{failed:true})
    render()
    return toast(issue.message)
  }
  result = applyBrushPlan({ ...executionPlan, targets: executionPlan.targets?.length ? executionPlan.targets : executionGroup.targets }, executionGroup.strokes)
  if (!result?.ok) {
    patchGroup({applying:false})
    if (getBrushState().mode === 'brush') setLassoMode(true)
    agentJournal.execution(group.id, `未执行：${result?.reason || '这次修改没有应用'}`, { failed: true })
    return toast(result?.reason || '这次修改没有应用')
  }
  agentJournal.execution(group.id, `已执行：${result.message || plan.suggestion?.text || plan.goal}${report.warnings?.length ? `；${report.warnings.length} 项轻微排版提醒，未阻断` : ''}${imageExecution.length ? `；${imageExecution.join('；')}` : ''}`)
  addHistory({ label: result.message || plan.suggestion?.text || plan.goal });
  const textScope = ['replace', 'delete'].includes(plan.type) && targets.some((target) => target.kind === 'text')
    ? (Array.isArray(plan.targetRanges) && plan.targetRanges.length ? 'marked-range' : 'text-object')
    : ''
  recordEditEpisode({
    operation: plan.type,
    gestureRoles: [...new Set((group.strokes || []).map((stroke) => stroke.shape).filter(Boolean))],
    targetKinds: [...new Set((targets || []).map((target) => target.kind).filter(Boolean))],
    targetCount: targets.length,
    userChoice: group.customInstruction || group.userInstruction || plan.goal,
    execution: direct ? 'direct' : 'preview',
    outcome: 'applied',
    textScope,
  })
  const preferenceRecorded = isDurablePreference(group.customInstruction)
    ? (addPreference({ text: group.customInstruction, operation: plan.type }), recordExplicitPreference({ text: group.customInstruction, operation: plan.type }), true)
    : false
  toast(`${result.message || '修改已应用'}${preferenceRecorded ? '；已记录这次偏好' : ''}，可以撤销`)
  clearCurrentGroup()
}
function undo() {
  const edits = listWebEdits().filter((edit) => edit.keep !== false)
  if (!edits.length) return
  clearCurrentGroup()
  undoWebEditsSince(); markLatestEpisodeUndone(); agentJournal.undoLatest(); toast(`已撤销「${edits[0].label}」`); render()
}
function redo() {
  const edits = listWebEdits().filter((edit) => edit.keep === false)
  if (!edits.length) return
  const item = edits[0]
  if (!redoWebEdit(item.id)) return toast('这次修改无法重做')
  agentJournal.redoLatest()
  addHistory({ label: item.label })
  toast(`已恢复「${item.label}」`)
  render()
}
const importedPages = createImportedPageSession({
  cache: createImportedPageCache(),
  importPage,
  async mountPage(page) {
    const brushMode = getBrushState().mode
    clearCurrentGroup()
    disarmDrawing()
    unmountWebDoc(); resetBrushState()
    try {
      const mode = await applyImportedPage(editor, page)
      patchBrush({ pageLoaded: true, mode: brushMode })
      if (brushMode === 'brush') setLassoMode(true)
      refreshDecorations(editor)
      render()
      return mode
    } catch (error) {
      showStartGuide()
      throw error
    }
  },
})

async function loadImported(payload, ticket) {
  toast('正在读入网页…')
  try {
    const result = await importedPages.load(payload, ticket)
    if (!result) return
    const { page, storageError } = result
    const warning = page.warnings?.find((item) => /图片|资源/.test(item))
    toast(storageError ? '网页已导入，但本地保存失败，刷新后无法恢复本次网页'
      : `已导入「${page.title || '网页'}」，刷新后自动恢复${warning ? `；${warning}` : ''}`)
  } catch (error) { toast(error?.message || '导入失败，请检查 HTML 文件') }
}

async function restoreImportedPage() {
  try {
    const result = await importedPages.restore()
    if (result) toast(`已恢复上次导入的「${result.page.title || '网页'}」`)
  } catch {
    toast('无法读取上次保存的网页，请重新导入')
  }
}
function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('asset read failed'))
    reader.readAsDataURL(file)
  })
}

function normalizeLocalPath(value) {
  const parts = decodeURIComponent(String(value || '').replace(/\\/g, '/')).split('/')
  const out = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/').toLowerCase()
}

async function inlineSelectedLocalAssets(html, htmlFile, selectedFiles) {
  const assets = new Map()
  for (const file of selectedFiles) {
    if (file === htmlFile || (!file.type.startsWith('image/') && !/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[-?].*)?$/i.test(file.name))) continue
    try {
      const data = await fileDataUrl(file)
      const full = normalizeLocalPath(file.webkitRelativePath || file.name)
      assets.set(full, data)
      assets.set(full.split('/').pop(), data)
    } catch {}
  }
  if (!assets.size) return html
  const htmlPath = normalizeLocalPath(htmlFile.webkitRelativePath || htmlFile.name)
  const baseDir = htmlPath.split('/').slice(0, -1).join('/')
  return String(html || '').replace(
    /((?:src|data-src|data-original|srcset)\s*=\s*[\"'])([^\"']+)([\"'])/gi,
    (match, prefix, raw, suffix) => {
      const first = String(raw).split(',')[0].trim().split(/\s+/)[0]
      if (!first || /^(?:data:|https?:|blob:|#|\/\/)/i.test(first)) return match
      const key = normalizeLocalPath(first)
      const data = assets.get(normalizeLocalPath(`${baseDir}/${key}`)) || assets.get(key) || assets.get(key.split('/').pop())
      return data ? `${prefix}${data}${suffix}` : match
    },
  )
}

function openFilePicker() {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = '.html,.htm,text/html,image/*'
  input.hidden = true
  document.body.append(input)
  input.addEventListener('cancel', () => input.remove(), { once: true })
  input.addEventListener('change', async () => {
    try {
      const files = [...(input.files || [])]
      const file = files.find((item) => /\.html?$/i.test(item.name))
      if (!file) return toast('请选择一个 HTML 文件；如果图片在旁边，也可以一起多选图片文件')
      const ticket = importedPages.beginImport()
      const rawHtml = await file.text()
      if (!rawHtml.trim()) return toast('这个 HTML 文件是空的')
      const html = await inlineSelectedLocalAssets(rawHtml, file, files)
      await loadImported({ html }, ticket)
    } catch (error) {
      toast(error?.message || '读取网页失败')
    } finally {
      input.remove()
    }
  })
  input.click()
}
function setPanelOpen(open) {
  document.body.classList.toggle('is-panel-collapsed', !open)
  els.togglePanel.setAttribute('aria-expanded', String(open))
  els.togglePanel.setAttribute('title', open ? '收起修改工作台' : '展开修改工作台')
  els.togglePanel.textContent = open ? '›' : '‹'
  try { localStorage.setItem('markset-panel-open', open ? '1' : '0') } catch {}
  requestAnimationFrame(() => {
    refreshWebDocLayout()
    render()
    if (open && panelView !== 'home') {
      const sections = { history: els.history, preferences: document.getElementById('preference-section'), models: document.getElementById('model-status-section'), agent: document.getElementById('agent-record-section') }
      const section = sections[panelView]
      section?.scrollIntoView({ block: 'start' })
    }
  })
}

function focusDetails() {
  setPanelOpen(true)
  requestAnimationFrame(() => {
    const intent = getBrushState().group?.inferredIntent
    if (intent?.needsInput) els.replaceInput.focus()
    else if (intent?.type === 'reorder') els.layoutPreview.focus()
    else els.dismiss.focus()
  })
}

function handleInlinePrimary() {
  if (getBrushState().group?.status === 'draft' && (!getBrushSettings().autoAnalyze || getBrushState().group.analysisPaused)) return analyzeMarkedGroup()
  const action = els.inlinePrimary.dataset.action
  const execution = action === 'preview' || (action === 'feedback' && getEffectiveBehaviorProfile().clearIntentAction === 'preview') ? 'preview' : 'direct'
  const group = getBrushState().group
  if (!group || group.status === 'analyzing' || group.applying || strokeActive) return
  if (group.modelPending) return
  const hasCustomText = Boolean(els.inlineCustomInput.value.trim() || els.inlineInput.value.trim())
  const hasClarificationAnswer = Boolean(group?.selectedAlternative)
  // A correction also invalidates an old preview. Both Enter and click honor
  // the action shown on the button, including an explicitly chosen preview preference.
  if (els.inlineCustomInput.value.trim() || hasClarificationAnswer) {
    return interpretCustomIntent(execution, group.selectedAlternative || '')
  }
  if (action === 'apply') return applyProposal()
  if (action === 'direct') {
    if (hasCustomText && (group?.inferredIntent?.needsClarification || group?.inferredIntent?.type === 'note')) return interpretCustomIntent('direct', group?.selectedAlternative || '')
    return applyProposal({ direct: true })
  }
  if (action === 'feedback') {
    if (hasClarificationAnswer || hasCustomText) return interpretCustomIntent(execution, group?.selectedAlternative || '')
    return toast('请先选择一种修改方式，或补充你的具体要求')
  }
  if (action === 'preview') {
    if (getBrushState().group?.inferredIntent?.needsInput) els.replaceInput.value = els.inlineInput.value
    return previewProposal()
  }
  focusDetails()
}

els.togglePanel.addEventListener('click', () => setPanelOpen(document.body.classList.contains('is-panel-collapsed')))
bindIntentSubmission({ primary: els.inlinePrimary, customSubmit: els.inlineCustomSubmit, input: els.inlineCustomInput, analysis: $('btn-analyze-strokes') }, handleInlinePrimary, () => {
  const group = getBrushState().group
  if (!group || strokeActive || group.applying) return
  if (group.modelPending || group.status === 'analyzing') {
    clearTimeout(analysisTimer)
    cancelModelAnalysis()
    patchGroup({status:'draft',modelPending:false,analysisPaused:true,analysisProgress:null,
      feedbackDraft:group.feedbackDraft || group.analysisSubmittedDraft || '', modelError:'',analysisIssue:null})
    render()
    return
  }
  analyzeMarkedGroup()
})
els.inlineDetails.addEventListener('click', () => {
  const group = getBrushState().group
  if (group?.status === 'previewing') { patchGroup({ status: 'suggested', preview: null }); render() }
  else previewProposal()
})
async function interpretCustomIntent(execution = 'direct', selectedChoice = '') {
  const group = getBrushState().group
  if (!group || group.status === 'analyzing' || group.applying || strokeActive) return
  const choice = String(selectedChoice || group?.selectedAlternative || '').trim()
  const typed = String(group?.feedbackDraft || group?.replacementText || els.inlineCustomInput.value || els.inlineInput.value || '').trim()
  const reply = [choice, typed].filter(Boolean).join('；补充：')
  if (!group || !reply) return toast('先选择一个方向，或补充具体要求')
  clearTimeout(analysisTimer)
  cancelModelAnalysis()
  let requestEpoch = modelRequestSeq
  try {
    const finish = () => execution === 'analyze' ? undefined : execution === 'preview' ? previewProposal() : applyProposal({ direct: true })
    const candidate = candidateForChoice(group.inferredIntent,choice)
    if (candidate && !typed) {
      patchGroup({inferredIntent:{...candidate,requiresConfirmation:false},replacementText:candidate.replacementText || '',customInstruction:[group.customInstruction || group.userInstruction,`用户确认方案：${candidate.suggestion?.text || candidate.goal}`].filter(Boolean).join('\n'),selectedAlternative:'',intentLocked:true,feedbackDraft:'',status:'suggested'})
      // This button click confirms a concrete candidate, not a tool category.
      await finish()
      return
    }
    const numberedReference = hasBrushRegionReference(typed || choice)
    const completePlan = numberedReference ? null : inferCompleteActionPlan(typed || choice, group.targets || [], group.localIntent || group.inferredIntent || {})
    const baseInstruction = group.customInstruction || group.userInstruction || ''
    const question = group.inferredIntent?.clarifyingQuestion || ''
    const answer = formatClarificationAnswer(question, choice, typed)
    const instruction = completePlan ? (typed || choice) : baseInstruction
      ? `${baseInstruction}\n${answer}`
      : answer
    const userInstruction = group.userInstruction || reply
    const answeredClarifications = question
      ? [...new Set([...(group.answeredClarifications || []), question])].slice(-6)
      : (group.answeredClarifications || [])

    // When the model explicitly asks for the replacement copy, don't send the
    // user through another interpretation round if one marked text object gives
    // us an exact, safe source. The user has supplied the new copy and pressed
    // “修改”, which is the confirmation to replace that marked title/text.
    if (!completePlan && !isEditInstruction(typed) && !choice && typed && clarificationNeedsContent(group.inferredIntent) && /替换|更换/u.test(question)) {
      const textTargets = (group.targets || []).filter((target) => target.kind === 'text' && target.webId && !target.textTruncated && String(target.text || '').trim())
      if (textTargets.length === 1) {
        const target = textTargets[0]
        const targetText = String(target.text || '').trim()
        const replaceInstruction = `将当前标记的完整文本替换为：${typed}`
        const plan = {
          ...group.inferredIntent,
          type: 'replace', operation: 'replace', targets: [target], targetText, replacementText: typed,
          targetRanges: [{ targetId: String(target.webId), start: 0, end: targetText.length }],
          needsInput: false, needsClarification: false, confidence: 0.99,
          goal: '替换标记的完整文本',
          rationale: '用户已输入完整的新内容，并确认修改；只标记了一个完整文本对象。',
          strategy: '只替换该标记文本对象的文字，保留页面其他内容和结构。',
          impact: { scope: '一个标记文本对象', riskLevel: 'low' },
          suggestion: { text: '替换标记文本', alternatives: [] },
          source: 'user_clarification',
        }
        const dryRun = applyBrushTextReplacement([target], { targetText, targetRanges: plan.targetRanges, replacementText: typed }, { dryRun: true })
        if (dryRun?.ok) {
          recordLocalDecision(group, plan, reply)
          patchGroup({
            userInstruction,
            customInstruction: replaceInstruction,
            inferredIntent: plan,
            localIntent: plan,
            feedbackDraft: '',
            replacementText: typed,
            selectedAlternative: '',
            status: 'suggested',
            preview: null,
            modelError: '', analysisIssue: null,
          })
          render()
          finish()
          return
        }
      }
    }

    patchGroup({ userInstruction, customInstruction: instruction, feedbackDraft:typed, analysisSubmittedDraft:typed,
      replacementText: '', selectedAlternative: '', answeredClarifications, intentLocked: false, status: 'analyzing', modelPending: false,
      analysisPaused:false, analysisProgress:{stage:'preparing',startedAt:Date.now(),draftSummary:''}, preview: null, modelError: '', analysisIssue: null })
    render()
    // Model context contains labels such as “补充的信息/具体要求”. Those labels
    // are not user verbs (in particular, “补充” must not invent an insert action).
    const localInstruction = [choice, typed].filter(Boolean).join('；')
    const explicitReplacement = numberedReference ? null : parseExplicitTextReplacement(typed || choice, group.targets || [])
    const geometricIntent = completePlan || interpretGroup({ ...group, userInstruction: instruction })
    const localIntent = completePlan || (explicitReplacement ? {
      ...geometricIntent, type: 'replace', operation: 'replace_text', targets: explicitReplacement.targets,
      targetText: explicitReplacement.targetText, replacementText: explicitReplacement.replacementText,
      targetRanges: explicitReplacement.targetRanges, needsInput: false, confidence: 0.99, source: 'user_instruction',
      suggestion: { text: `将“${explicitReplacement.targetText}”替换为“${explicitReplacement.replacementText}”`, alternatives: [] },
      hint: '已按你明确给出的原文和新文案定位；确认前不会改动网页。',
    } : (!numberedReference && inferLocalActionPlan(localInstruction, geometricIntent, group.targets || [])) || {
      ...geometricIntent, type: 'note', operation: 'note', confidence: 0.4, needsInput: false,
      suggestion: { text: `我理解你希望：${instruction}`, alternatives: [] },
      hint: '这是对你原始描述的保守理解。系统没有确定修改方案前不会改动网页。',
    })
    patchGroup({ localIntent })
    const snapshot = { ...getBrushState().group }
    const publishLocal = () => {
      recordLocalDecision(snapshot, localIntent, reply)
      return patchGroupAnalysis(snapshot, {
        inferredIntent: localIntent, suggestion: localIntent.suggestion,
        replacementText: completePlan?.replacementText || explicitReplacement?.replacementText || '', feedbackDraft: '',
        status: 'suggested', model: null, modelError: '', analysisIssue: null,
        modelPending: false,
      })
    }
    const finished = await finishIntentSubmission({
      snapshot,
      getCurrent: () => getBrushState().group,
      isCurrent: () => !strokeActive && requestEpoch === modelRequestSeq,
      resolvedPlan: completePlan,
      resolve: async () => {
        const pending = askModelToInterpret(snapshot, localIntent, instruction)
        requestEpoch = modelRequestSeq
        await pending
      },
      publish: publishLocal,
      finish,
    })
    if (!finished && requestEpoch === modelRequestSeq && !strokeActive
      && getBrushState().group?.inferredIntent?.source === 'local-fallback'
      && !getBrushState().group?.inferredIntent?.needsInput) {
      patchGroupAnalysis(snapshot, { feedbackDraft: typed })
    }
  } catch (error) {
    // A synchronous classifier/plan exception used to escape this async event
    // handler after status='analyzing', leaving the UI locked indefinitely.
    console.debug('[markset brush] submitted analysis failed', error)
    if (requestEpoch !== modelRequestSeq || strokeActive) return
    const fallback = analysisRecoveryIntent(group)
    recordLocalDecision(group, fallback, reply, analysisIssue(error))
    const recovered = patchGroupAnalysis(group, {
      status: 'suggested', inferredIntent: fallback, localIntent: fallback, suggestion: fallback.suggestion,
      preview: null, model: null, modelError: '', analysisIssue: analysisIssue(error), feedbackDraft: typed, replacementText: '',
      selectedAlternative: '', intentLocked: false,
    })
    if (recovered) toast('这次识别没有完成，笔迹和输入已保留，可以重试')
  }
}
els.inlineCustomInput.addEventListener('input', () => {
  const group = getBrushState().group
  if (group) patchGroup({ feedbackDraft: els.inlineCustomInput.value })
})
els.inlineRetry.addEventListener('click', () => {
  const group = getBrushState().group
  if (group?.imageError) return void applyProposal({ direct: true })
  if (!group || group.status === 'analyzing' || group.applying || strokeActive) return
  const previous = group.customInstruction || group.userInstruction || ''
  const draft = String(group.feedbackDraft || '').trim()
  const instruction = draft && !previous.includes(draft)
    ? [previous, `最新补充要求：${draft}`].filter(Boolean).join('\n') : previous || draft
  patchGroup({ status: 'analyzing', modelError: '', analysisIssue: null, customInstruction: instruction })
  render()
  // Retrying understanding is not permission to apply a fallback plan.
  void askModelToInterpret({ ...getBrushState().group }, group.localIntent || group.inferredIntent, instruction)
})
els.inlineDismiss.addEventListener('click', clearCurrentGroup)
els.inlineInput.addEventListener('input', () => {
  els.replaceInput.value = els.inlineInput.value
  const group = getBrushState().group
  if (group) patchGroup({ replacementText: els.inlineInput.value })
})
try { setPanelOpen(localStorage.getItem('markset-panel-open') !== '0') } catch { setPanelOpen(true) }
try { setPanelView(localStorage.getItem('markset-panel-view') || 'home') } catch { setPanelView('home') }

els.import.addEventListener('click', openFilePicker); els.guideImport.addEventListener('click', openFilePicker)
els.export.addEventListener('click', () => { if (exportWebDoc()) toast('网页已导出') })
els.brush.addEventListener('click', () => toggleBrush()); els.clearStrokes.addEventListener('click', clearCurrentGroup)
els.preview.addEventListener('click', previewProposal); els.apply.addEventListener('click', applyProposal); els.dismiss.addEventListener('click', clearCurrentGroup)
els.replaceInput.addEventListener('input', () => { els.inlineInput.value = els.replaceInput.value; const group = getBrushState().group; if (group) patchGroup({ replacementText: els.replaceInput.value }) })
els.keepDrawing.addEventListener('click', () => { patchGroup({ status: 'draft', preview: null }); toggleBrush(true); render() })
els.undo.addEventListener('click', undo); els.redo.addEventListener('click', redo); els.layoutPreview.addEventListener('click', previewProposal)
els.preferenceRecording?.addEventListener('change', () => {
  const enabled = els.preferenceRecording.checked
  setPreferenceRecording(enabled)
  setBehaviorLearning(enabled)
  toast(enabled ? '已开启受控习惯学习' : '已关闭习惯学习')
})
els.clearPreferences?.addEventListener('click', () => { clearPreferences(); toast('偏好记录已清空') })
els.clearBehavior?.addEventListener('click', () => {
  clearBehaviorOverrides()
  toast('已恢复默认行为并清空学习记录')
})
const behaviorPreferenceControls = [
  ['clearIntentAction', els.behaviorClearAction],
  ['ambiguousMode', els.behaviorAmbiguousMode],
  ['textScope', els.behaviorTextScope],
  ['editStyle', els.behaviorEditStyle],
]
for (const [key, control] of behaviorPreferenceControls) {
  control?.addEventListener('change', () => {
    if (setBehaviorPreference(key, control.value)) toast('已更新行为偏好')
  })
}
document.querySelectorAll('[data-panel-target]').forEach((button) => button.addEventListener('click', () => {
  setPanelOpen(true)
  const view = button.dataset.panelTarget
  setPanelView(view)
  if (view !== 'home') requestAnimationFrame(() => document.querySelector('.side-scroll')?.scrollTo({ top: 0, behavior: 'smooth' }))
}))
bindLasso({ onStart: onStrokeStarted, onFinish: onStrokeFinished, onCancel: () => {
  strokeActive = false
  if (getBrushState().group) scheduleAnalysis()
} })
window.addEventListener('keydown', (event) => {
  // B may enter drawing mode; only the explicit toolbar button exits it.
  if ((event.key === 'b' || event.key === 'B') && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault()
    if (getBrushState().mode !== 'brush') toggleBrush(true)
  }
  if (event.key === 'Escape' && getBrushState().group) clearCurrentGroup()
})
window.addEventListener('markset:page-layout', render)
subscribeBrushSettings((settings, before) => {
  const group = getBrushState().group
  if (!settings.autoAnalyze && before.autoAnalyze) {
    clearTimeout(analysisTimer)
    if (group && (modelAbortController || group.modelPending || group.status === 'analyzing')) {
      cancelModelAnalysis()
      patchGroup({ status: 'draft', inferredIntent: null, localIntent: null, suggestion: null, modelPending: false, analysisIssue: null, modelError: '' })
    }
  } else if (settings.autoAnalyze && group?.status === 'draft' && !strokeActive
    && (!before.autoAnalyze || settings.analysisDelayMs !== before.analysisDelayMs)) scheduleAnalysis()
  render()
})
window.addEventListener('resize', render); window.addEventListener('scroll', render, true); subscribeBrush(render); subscribeBehaviorMemory(render); render()
void restoreImportedPage()
