import { COLORS } from './colors.js'
import { checkNodeSpecs, checkStyleDeclarations, PLACEMENTS } from './edit-capabilities.js'

function cleanQuoted(value) {
  return String(value || '').trim().replace(/^[\s"“”‘’'「」『』]+|[\s"“”‘’'「」『』。.!！?？]+$/gu, '').trim()
}

export function parseExplicitTextReplacement(instruction, targets = []) {
  const input = String(instruction || '').trim()
  if (!input) return null
  // “把标题改成红色” is a style request, not a request to replace the word
  // “标题” with “红色”. Keep style/layout language out of this exact-text fast path.
  if (/(?:变成|改成|改为|设置为|调整为|换成).{0,14}(?:红色|蓝色|绿色|黄色|橙色|紫色|黑色|白色|粉色|灰色|金色|加粗|斜体|下划线|居中|左对齐|右对齐|字号|字体|背景色|透明)/u.test(input)) return null
  const patterns = [
    /^(?:请)?(?:把|将)?\s*(.+?)\s*(?:替换为|替换成|修改为|改成|改为|换成)\s*(.+?)\s*[。.!！?？]*$/u,
    /^(?:请)?(?:修改|替换|更换)\s+(.+?)\s*(?:为|成)\s*(.+?)\s*[。.!！?？]*$/u,
  ]
  let match = null
  for (const pattern of patterns) { match = input.match(pattern); if (match) break }
  if (!match) return null
  const targetText = cleanQuoted(match[1])
  const replacementText = cleanQuoted(match[2])
  if (!targetText || !replacementText || targetText === replacementText || replacementText === input) return null

  const matches = []
  for (const target of targets || []) {
    if (target?.kind !== 'text' || !target.webId) continue
    const source = String(target.text || '')
    let from = 0
    while (from <= source.length) {
      const start = source.indexOf(targetText, from)
      if (start < 0) break
      matches.push({ target, start, end: start + targetText.length })
      from = start + Math.max(1, targetText.length)
    }
  }
  // Do not guess which occurrence to change. A unique visible-text match is required.
  if (matches.length !== 1) return null
  const found = matches[0]
  return {
    targetText, replacementText,
    targets: [found.target],
    targetRanges: [{ targetId: String(found.target.webId), start: found.start, end: found.end }],
  }
}


export const SUPPORTED_OPERATIONS = Object.freeze(['reorder', 'replace', 'replace-image', 'delete', 'insert', 'color', 'style', 'move', 'note', 'batch'])

const targetKinds = {
  reorder: (targets) => targets.length >= 2,
  replace: (targets) => targets.some((target) => target.kind === 'text'),
  'replace-image': (targets) => targets.some((target) => target.kind === 'image'),
  delete: (targets) => targets.length > 0,
  insert: (targets, plan) => Boolean(plan.insertion?.anchorId || plan.parameters?.bounds || plan.insertionPoint || plan.location),
  color: (targets) => targets.length > 0,
  style: (targets) => targets.length > 0,
  move: (targets) => targets.length > 0,
  note: () => true,
  batch: () => true,
}

const negationPatterns = [
  { action: 'replace', pattern: /(?:不要|别|不想|并非|不是|保持).{0,18}(?:改|替换|重写|润色|修改|动).{0,12}(?:文字|文本|文案|内容)/u },
  { action: 'replace', pattern: /(?:只|仅|只要).{0,16}(?:改|调整|移动|重排|排列).{0,10}(?:布局|位置|顺序)/u },
  { action: 'replace-image', pattern: /(?:不要|别|不想|并非|不是|保持).{0,18}(?:换|替换|修改|动).{0,10}(?:图片|图像|配图)/u },
  { action: 'delete', pattern: /(?:不要|别|不想|并非|不是|保留).{0,18}(?:删|删除|移除|去掉)/u },
  { action: 'reorder', pattern: /(?:不要|别|不想|并非|不是|保持).{0,18}(?:重排|排列|移动|调整顺序)/u },
  { action: 'insert', pattern: /(?:不要|别|不想|并非|不是).{0,18}(?:添加|新增|插入)/u },
]

export function hasIntentConflict(instruction, operation) {
  const text = String(instruction || '').trim()
  return negationPatterns.some((item) => item.action === operation && item.pattern.test(text))
}

const explicitActionPatterns = {
  reorder: /(?:重排|重新排列|排列|调整顺序|换个顺序|横向|纵向|移到|移动到|布局整理|整理布局)/u,
  replace: /(?:替换|改成|改为|改写|重写|润色|修改|更新|优化).{0,16}(?:文字|文本|文案|标题|描述|内容)|(?:文字|文本|文案|标题|描述|内容).{0,16}(?:替换|改成|改为|改写|重写|润色|修改|更新|优化)|.{1,40}(?:改成|改为|替换成|替换为|换成).{1,40}/u,
  'replace-image': /(?:换|替换|更换|更新).{0,12}(?:图片|图像|配图)|(?:图片|图像|配图).{0,12}(?:换|替换|更换|更新)/u,
  delete: /(?:删除|移除|去掉|删掉|拿掉|隐藏)/u,
  insert: /(?:添加|新增|插入|增加|补充).{0,16}(?:内容|模块|卡片|区块|元素|文字|图片|位置)?/u,
  color: /(?:颜色|变红|变蓝|变绿|改成.{0,8}(?:红|蓝|绿|黑|白|粉|黄)|改为.{0,8}(?:红|蓝|绿|黑|白|粉|黄))/u,
}

/** A marked region or general criticism is not authorization to choose an edit. */
export function hasExplicitAction(instruction, operation) {
  const pattern = explicitActionPatterns[operation]
  if (operation === 'color' && parseCompleteColorInstruction(instruction)) return true
  return !String(instruction || '').trim() || !pattern || pattern.test(String(instruction))
}

// Only a complete, single-action sentence may bypass model interpretation.
// Do not search keywords in the conversation history: an earlier question,
// negation, background-color request or compound instruction is not this edit.
function parseCompleteColorInstruction(instruction) {
  const text = String(instruction || '').trim().replace(/\s+/gu, '')
  const match = text.match(/^(?:请|帮我|请帮我)?(?:把|将)?(?:(?:当前|这些|这个|选中的|标记的|圈住的)?(?:文字|文本|标题|标记对象|标记内容))?(?:的)?(?:颜色|文字颜色|文本颜色|字体颜色)?(?:改成|改为|修改为|设置为|调整为|变成|换成)([^，,；;。.!！?？]+)[。.!！]*$/u)
  if (!match) return null
  const value = match[1]
  const named = COLORS.find(({ id }) => id === value || (id.endsWith('色') && id.slice(0, -1) === value))
  const color = named?.id || (/^#[\da-f]{6}$/iu.test(value) ? value.toLowerCase() : '')
  return color ? { color, headingOnly: /标题/u.test(text) } : null
}

export function inferCompleteColorPlan(instruction, targets = []) {
  const parsed = parseCompleteColorInstruction(instruction)
  if (!parsed || !targets.length || targets.some((target) => !target.webId || target.kind !== 'text')) return null
  if (parsed.headingOnly && targets.some((target) => !/^h[1-6]$/u.test(target.context?.tag || ''))) return null
  // Build from clean state, not from an obsolete replacement/clarification plan.
  const plan = localActionPlan({}, targets, 'color', instruction, { color: parsed.color })
  return validateIntentPlan(plan, targets, instruction).actionable ? plan : null
}

// Distinguish a new edit request from literal copy in a replacement answer box.
export function isEditInstruction(text) {
  return Object.values(explicitActionPatterns).some((pattern) => pattern.test(String(text || '')))
    || /^(?:请|帮我)?(?:不要|别|不是|不想|保留|撤销)/u.test(String(text || '').trim())
}

export function inferCompleteDeletionPlan(instruction, targets = [], evidence = {}) {
  if (!targets.length || targets.some((target) => !target?.webId)) return null
  const text = String(instruction || '').trim().replace(/[。.!！]+$/u, '')
    .replace(/^(?:(?:请帮我|帮我|麻烦|请|直接)\s*)+/u, '').replace(/吧$/u, '').trim()
  const match = text.match(/^(?:只|仅)?(?:把|将)(.+?)(?:删除|移除|去掉|删掉|拿掉)$/u)
    || text.match(/^(?:只|仅)?(?:删除|移除|去掉|删掉|拿掉)(.*?)$/u)
  if (!match) return null
  const subject = match[1].trim()
  let selected = targets
  let ranges = []
  // Quoted source text is an exact range request, not permission to remove
  // the containing module. Refuse absent/repeated text rather than guessing.
  if (/^[“"「『]/u.test(subject)) {
    if (!/^[“"「『][\s\S]+[”"」』]$/u.test(subject)) return null
    const source = cleanQuoted(subject)
    if (!source) return null
    const matches = []
    for (const target of targets.filter((item) => item.kind === 'text' && !item.textTruncated)) {
      const value = String(target.text || '')
      for (let from = 0; from < value.length;) {
        const start = value.indexOf(source, from)
        if (start < 0) break
        matches.push({ target, range: { targetId: String(target.webId), start, end: start + source.length, expectedText: source } })
        from = start + source.length
      }
    }
    if (matches.length !== 1) return null
    selected = [matches[0].target]
    ranges = [matches[0].range]
  } else {
    const scope = subject.replace(/\s+/gu, '')
    const partial = /^(?:(?:被)?(?:画线|划线|划过|笔迹划过|圈住|标记)(?:的)?(?:字|词|字词|文字|文本)|这(?:几个|两个|些)(?:字|词|字词))$/u.test(scope)
    const whole = /^(?:(?:当前|所有|全部|整个|整块|整段|整张|所选|选中(?:的)?|标记(?:的)?|圈住(?:的)?|这(?:一)?[个块段张]|这些|它们|它))*(?:内容|对象|组件|模块|区块|卡片|图片|图像|标题|段落|文字|文本)?$/u.test(scope)
    if (!partial && !whole) return null
    if (partial || (!scope && evidence.type === 'delete' && evidence.targetRanges?.length)) {
      ranges = evidence.targetRanges?.length ? evidence.targetRanges : evidence.parameters?.targetRanges || []
      if (!ranges.length) return null
      selected = targets.filter((target) => ranges.some((range) => String(range.targetId) === String(target.webId)))
    } else if (/标题$/u.test(scope)) {
      selected = targets.filter((target) => /^h[1-6]$/u.test(target.context?.tag || ''))
    } else if (/段落$/u.test(scope)) {
      selected = targets.filter((target) => /^(?:p|li|blockquote)$/u.test(target.context?.tag || ''))
    } else if (/(?:图片|图像)$/u.test(scope)) {
      selected = targets.filter((target) => target.kind === 'image')
    } else if (/(?:文字|文本)$/u.test(scope)) {
      selected = targets.filter((target) => target.kind === 'text')
    }
  }
  // Crucially, object removal starts with clean state. Geometry's character
  // hits and a previous replacement plan must not shrink a module deletion.
  const plan = localActionPlan({ targetRanges: ranges }, selected, 'delete', instruction)
  plan.parameters = { deletionScope: ranges.length ? 'text-range' : 'object' }
  return validateIntentPlan(plan, targets, instruction).actionable ? plan : null
}

/** A complete current instruction outranks old choices and needs no model call. */
export function inferCompleteActionPlan(instruction, targets = [], evidence = {}) {
  const direct = inferCompleteColorPlan(instruction, targets) || inferCompleteDeletionPlan(instruction, targets, evidence)
  if (direct) return direct
  const replacement = parseExplicitTextReplacement(instruction, targets)
  if (!replacement) return null
  const plan = localActionPlan({ targetRanges: replacement.targetRanges }, replacement.targets, 'replace', instruction, replacement)
  return validateIntentPlan(plan, targets, instruction).actionable ? plan : null
}

const COLOR_NAMES = [
  ['红色', '红'], ['蓝色', '蓝'], ['绿色', '绿'], ['黄色', '黄'],
  ['橙色', '橙'], ['紫色', '紫'], ['黑色', '黑'], ['白色', '白'],
  ['粉色', '粉'], ['灰色', '灰'], ['金色', '金'], ['棕色', '棕'],
]

function requestedColor(instruction) {
  const text = String(instruction || '')
  const found = COLOR_NAMES.find(([full, short]) => text.includes(full) || text.includes(short))
  return found?.[0] || ''
}

function instructionTargets(baseIntent, targets) {
  return baseIntent?.targets?.length ? baseIntent.targets : (targets || [])
}

function localActionPlan(baseIntent, targets, type, instruction, extra = {}) {
  const selectedTargets = instructionTargets(baseIntent, targets)
  const direction = extra.direction || baseIntent?.parameters?.direction || 'horizontal'
  const ranges = Array.isArray(baseIntent?.targetRanges) && baseIntent.targetRanges.length
    ? baseIntent.targetRanges
    : (Array.isArray(baseIntent?.parameters?.targetRanges) ? baseIntent.parameters.targetRanges : [])
  const common = {
    ...baseIntent,
    type,
    operation: type === 'replace' ? 'replace_text' : type,
    targets: selectedTargets,
    needsClarification: false,
    clarificationAlreadyAnswered: false,
    clarifyingQuestion: '',
    confidence: Math.max(0.82, Number(baseIntent?.confidence) || 0),
    rationale: '用户已经明确指定了修改动作；笔迹负责限定作用范围。',
    constraints: ['只作用于已标记对象', '不修改未标记的页面内容'],
    source: 'local-instruction',
    ...extra,
  }
  if (type === 'delete') {
    return {
      ...common,
      goal: ranges.length ? '删除笔迹标记的文字' : '移除标记的页面内容',
      strategy: ranges.length ? '只删除被笔迹覆盖的文字范围，保留同一文本对象中的其他内容。' : '移除被笔迹明确标记的页面对象。',
      targetRanges: ranges,
      needsInput: false,
      impact: { scope: ranges.length ? '标记文字范围' : `${selectedTargets.length} 个标记对象`, riskLevel: 'medium' },
      suggestion: { text: ranges.length ? '删除标记的文字' : '移除标记内容', alternatives: [] },
      hint: ranges.length ? '将只删除笔迹划过的字词。' : '将移除笔迹明确标记的对象。',
    }
  }
  if (type === 'reorder') {
    return {
      ...common,
      goal: `将标记对象整理为${direction === 'vertical' ? '纵向' : '横向'}排列`,
      strategy: `保留对象内容，仅调整为${direction === 'vertical' ? '纵向' : '横向'}排列。`,
      parameters: { ...(baseIntent?.parameters || {}), direction },
      impact: { scope: `${selectedTargets.length} 个标记对象`, riskLevel: 'medium' },
      suggestion: { text: `重新${direction === 'vertical' ? '纵向' : '横向'}排列标记对象`, alternatives: [] },
      hint: '将保留内容，只调整这些对象的布局顺序。',
      needsInput: false,
    }
  }
  if (type === 'replace-image') {
    return {
      ...common,
      goal: '替换标记的图片',
      strategy: '保留图片位置和尺寸，只替换图片资源。',
      impact: { scope: `${selectedTargets.length} 个图片对象`, riskLevel: 'medium' },
      suggestion: { text: '替换标记的图片', alternatives: [] },
      hint: '请输入图片 URL，或使用后续的生图能力提供新图片。',
      needsInput: true,
    }
  }
  if (type === 'color') {
    const color = extra.color || requestedColor(instruction)
    return {
      ...common,
      goal: color ? `将标记内容改为${color}` : '调整标记内容的颜色',
      strategy: '只调整标记对象的颜色，不改变文字内容和布局。',
      parameters: { ...(baseIntent?.parameters || {}), color },
      color,
      replacementText: color,
      impact: { scope: `${selectedTargets.length} 个标记对象`, riskLevel: 'low' },
      suggestion: { text: color ? `改为${color}` : '调整颜色', alternatives: [] },
      hint: color ? `将标记内容改为${color}。` : '请输入目标颜色。',
      needsInput: !color,
    }
  }
  if (type === 'insert') {
    return {
      ...common,
      goal: '在标记位置添加内容',
      strategy: '在笔迹框出的空白位置添加内容，并尽量继承周边样式。',
      parameters: { ...(baseIntent?.parameters || {}), bounds: baseIntent?.parameters?.bounds || extra.bounds },
      impact: { scope: '一个标记位置', riskLevel: 'medium' },
      suggestion: { text: '在标记位置添加内容', alternatives: [] },
      hint: '请输入要添加的文字或内容。',
      needsInput: true,
    }
  }
  if (type === 'replace') {
    const textTarget = selectedTargets.find((target) => target.kind === 'text')
    const fullText = textTarget && !textTarget.textTruncated ? String(textTarget.text || '') : ''
    const replacement = extra.replacementText || ''
    return {
      ...common,
      goal: '替换标记的文字内容',
      strategy: '只替换标记文字，保留页面其他内容和结构。',
      targetText: extra.targetText || fullText,
      replacementText: replacement,
      targetRanges: ranges.length ? ranges : (textTarget && fullText ? [{ targetId: String(textTarget.webId), start: 0, end: fullText.length, expectedText: fullText }] : []),
      impact: { scope: textTarget ? '标记文字' : '标记对象', riskLevel: 'low' },
      suggestion: { text: '替换标记文字', alternatives: [] },
      hint: '请输入替换后的文字；未确认前不会改变网页。',
      needsInput: !replacement,
    }
  }
  return null
}

/** Create a deterministic plan for an explicit user-selected action. */
export function inferLocalActionPlan(instruction, baseIntent = {}, targets = []) {
  const text = String(instruction || '').trim()
  if (!text) return null
  const action = (name) => !hasIntentConflict(text, name) && explicitActionPatterns[name].test(text)
  if (action('delete')) {
    const complete = inferCompleteDeletionPlan(text, targets, baseIntent)
    if (complete) return complete
    // A restrictive, compound or uncertain deletion request must not degrade
    // to deleting every target just because a delete keyword was present.
    return {
      type: 'note', operation: 'note', targets, confidence: 0.6,
      goal: '确认要删除的范围', rationale: '删除动作已明确，但不能把具体范围要求简化成删除全部。',
      needsInput: false, needsClarification: true, clarifyingQuestion: '要移除整个选中对象，还是只删除其中的文字？',
      targetRanges: [], parameters: {},
      suggestion: { text: '确认要删除的范围', alternatives: ['移除整个选中对象', ...(baseIntent.targetRanges?.length ? ['只删除划线的文字'] : [])] },
      source: 'local-instruction',
    }
  }
  if (action('reorder')) {
    const direction = /纵向|上下|垂直/u.test(text) ? 'vertical' : /横向|左右|水平/u.test(text) ? 'horizontal' : ''
    return localActionPlan(baseIntent, targets, 'reorder', text, { direction })
  }
  if (action('insert')) return localActionPlan(baseIntent, targets, 'insert', text)
  if (action('replace-image')) return localActionPlan(baseIntent, targets, 'replace-image', text)
  if (action('color')) return localActionPlan(baseIntent, targets, 'color', text, { color: requestedColor(text) })
  if (action('insert')) return localActionPlan(baseIntent, targets, 'insert', text)
  if (action('replace')) return localActionPlan(baseIntent, targets, 'replace', text)
  return null
}

export function isDurablePreference(instruction) {
  return /(?:以后|今后|之后都|每次|始终|总是|默认|通常|我的偏好|我偏好|我喜欢|请记住|记住我|不要再)/u.test(String(instruction || '').trim())
}

/** Validate a model or local plan against supplied page objects and executable capabilities. */
export function validateIntentPlan(plan, availableTargets = [], userInstruction = '') {
  if (!plan || typeof plan !== 'object') return { ok: false, reason: 'empty-plan' }
  const rawOperation = plan.operation === 'replace_text' ? 'replace' : plan.operation
  const operation = SUPPORTED_OPERATIONS.includes(rawOperation) ? rawOperation : plan.type
  if (!SUPPORTED_OPERATIONS.includes(operation)) return { ok: false, reason: 'unsupported-operation' }
  const legal = new Map((availableTargets || []).filter((target) => target?.webId).map((target) => [String(target.webId), target]))
  const sourceTargets = Array.isArray(plan.targets) ? plan.targets : []
  const targets = sourceTargets.filter((target) => legal.has(String(target.webId)))
  if (targets.length !== sourceTargets.length) return { ok: false, reason: 'unknown-target' }
  const expanded = targets.filter((target) => legal.get(String(target.webId))?.related && !legal.get(String(target.webId))?.selected)
  // Read access to a module is not blanket write permission. Inserts may use
  // its anchors; other related-node edits require a disclosed scope change.
  if (expanded.length && !['note','insert','batch'].includes(operation)
    && !(plan.scopeExpansion?.length && expanded.every((target) => plan.scopeExpansion.includes(String(target.webId))))) return { ok: false, reason: 'scope-expansion-not-disclosed' }
  if (!targetKinds[operation](targets, plan)) return { ok: false, reason: 'invalid-target-set' }
  if (hasIntentConflict(userInstruction, operation)) return { ok: false, reason: 'contradicts-user-instruction' }
  // A model can infer an actionable design from natural phrasing and visual
  // evidence. Keyword presence is not a permission boundary: Apply is.
  if (operation !== 'note' && operation !== 'batch' && plan.source !== 'model' && !hasExplicitAction(userInstruction, operation)) return { ok: false, reason: 'action-not-explicitly-requested' }

  const confidence = Math.max(0, Math.min(1, Number(plan.confidence) || 0))
  const goal = String(plan.goal || plan.suggestion?.text || '').trim()
  const rationale = String(plan.rationale || plan.parameters?.modelReason || '').trim()
  const strategy = String(plan.strategy || '').trim()
  const impactScope = String(plan.impact?.scope || '').trim()
  const needsClarification = Boolean(plan.needsClarification)
  const riskLevel = ['low', 'medium', 'high'].includes(plan.impact?.riskLevel) ? plan.impact.riskLevel : 'medium'
  if (!goal) return { ok: false, reason: 'missing-goal' }
  if (!rationale && operation !== 'note') return { ok: false, reason: 'missing-rationale' }
  if ((!strategy || !impactScope) && operation !== 'note' && !needsClarification) return { ok: false, reason: !strategy ? 'missing-strategy' : 'missing-impact-scope' }
  if (needsClarification && !plan.clarifyingQuestion) return { ok: false, reason: 'missing-clarifying-question' }
  if (riskLevel === 'high' && !needsClarification) return { ok: false, reason: 'high-risk-needs-clarification' }
  if (confidence < (needsClarification ? 0 : 0.58) && operation !== 'note' && plan.source !== 'model') return { ok: false, reason: 'low-confidence' }
  if (operation === 'batch') {
    if (!Array.isArray(plan.steps) || plan.steps.length < 2 || plan.steps.length > 6) return { ok: false, reason: 'invalid-batch' }
    const deleted = new Set()
    for (const step of plan.steps) {
      if (step.type === 'batch' || step.type === 'note') return { ok: false, reason: 'unsupported-batch-step' }
      if ((step.targets || []).some((target) => deleted.has(String(target.webId))) || deleted.has(step.insertion?.anchorId)) return { ok: false, reason: 'batch-target-deleted' }
      // A transaction may declare scope once at its top level. That disclosed
      // boundary applies to its own steps, not to arbitrary other modules.
      const checked = validateIntentPlan({...step,scopeExpansion:[...new Set([...(plan.scopeExpansion || []),...(step.scopeExpansion || [])])]}, availableTargets, userInstruction)
      if (!checked.ok || !checked.actionable || step.needsInput) return { ok: false, reason: `batch:${checked.reason || 'missing-input'}` }
      if (step.type === 'delete' && !step.targetRanges?.length) for (const target of step.targets || []) deleted.add(String(target.webId))
    }
  }
  if (operation === 'insert') {
    const anchorId = plan.insertion?.anchorId
    if (anchorId && !legal.has(String(anchorId))) return { ok: false, reason: 'unknown-insertion-anchor' }
    const placement = plan.insertion?.placement || (plan.parameters?.bounds ? 'position' : 'after')
    if (!PLACEMENTS.includes(placement)) return {ok:false,reason:'invalid-insertion-placement'}
    if (placement === 'position') {
      const bounds = plan.parameters?.bounds
      if (!bounds || ![bounds.x,bounds.y,bounds.w,bounds.h].every(Number.isFinite) || bounds.w <= 0 || bounds.h <= 0) return { ok: false, reason: 'invalid-insertion-bounds' }
    } else if (!anchorId) return {ok:false,reason:'missing-insertion-anchor'}
  }
  if (operation === 'style') {
    const reason = checkStyleDeclarations(plan.styles)
    if (reason) return { ok: false, reason }
  }
  if (operation === 'move') {
    if (!plan.insertion?.anchorId || !legal.has(plan.insertion.anchorId) || !PLACEMENTS.includes(plan.insertion.placement) || plan.insertion.placement === 'position') return { ok: false, reason: 'invalid-move-anchor' }
    if (targets.some((target) => String(target.webId) === plan.insertion.anchorId)) return { ok: false, reason: 'move-into-self' }
  }
  const hasTextRanges = operation === 'replace' && Array.isArray(plan.targetRanges) && plan.targetRanges.length > 0
  if (operation === 'replace' && !hasTextRanges) {
    if (!String(plan.targetText || '').trim() || (!plan.needsInput && !String(plan.replacementText || '').trim())) return { ok: false, reason: 'missing-replacement-spec' }
  }
  if (operation === 'replace' && !hasTextRanges && !plan.needsInput && !targets.some((target) => String(target.text || '').includes(String(plan.targetText)))) return { ok: false, reason: 'source-text-not-in-target' }
  if (operation === 'replace' && plan.needsInput && !targets.some((target) => target.kind === 'text' && !target.textTruncated)) return { ok: false, reason: 'ambiguous-text-target' }
  if (['delete', 'replace'].includes(operation) && Array.isArray(plan.targetRanges) && plan.targetRanges.length) {
    const byId = new Map(targets.map((target) => [String(target.webId), target]))
    for (const range of plan.targetRanges) {
      const target = byId.get(String(range?.targetId || ''))
      const start = Number(range?.start)
      const end = Number(range?.end)
      if (!target || target.kind !== 'text' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return { ok: false, reason: 'invalid-text-range' }
      const text = String(target.text || '')
      const textLength = Number(target.textLength || text.length)
      if (end > textLength) return { ok: false, reason: 'text-range-out-of-bounds' }
      const expectedText = String(range?.expectedText || '').trim()
      if (expectedText && !target.textTruncated && text.slice(start, end) !== expectedText) return { ok: false, reason: 'text-range-mismatch' }
    }
  }
  if (operation === 'replace-image' && !plan.needsInput && !plan.replacementText && !plan.imagePrompt) return { ok: false, reason: 'missing-image-source' }
  if (operation === 'replace-image' && plan.needsInput && !targets.some((target) => target.kind === 'image')) return { ok: false, reason: 'missing-image-target' }
  if (operation === 'replace-image' && plan.imagePrompt && plan.imageMode !== 'generate' && targets.filter((target) => target.kind === 'image').length !== 1) return { ok: false, reason: 'image-edit-needs-one-original-per-step' }
  if (operation === 'insert' && plan.nodes?.length) {
    const reason = checkNodeSpecs(plan.nodes)
    if (reason) return { ok: false, reason }
  }
  if (operation === 'insert' && !plan.needsInput && !plan.replacementText && !plan.nodes?.length && !(plan.contentKind === 'image' && plan.imagePrompt)) return { ok: false, reason: 'missing-insert-content' }
  if (operation === 'color' && !String(plan.parameters?.color || plan.color || plan.replacementText || '').trim()) return { ok: false, reason: 'missing-color' }
  if (operation === 'delete' && riskLevel === 'high' && targets.length < 2) return { ok: false, reason: 'inconsistent-impact-scope' }
  if (operation === 'reorder' && !['horizontal', 'vertical'].includes(plan.parameters?.direction)) return { ok: false, reason: 'missing-layout-direction' }
  if (operation === 'reorder' && plan.parameters?.targetOrder?.length && (plan.parameters.targetOrder.length !== targets.length || new Set(plan.parameters.targetOrder).size !== targets.length || plan.parameters.targetOrder.some((id) => !targets.some((target) => String(target.webId) === id)))) return { ok: false, reason: 'invalid-target-order' }
  if (needsClarification) return { ok: true, actionable: false, operation, targets, reason: 'clarification-required' }
  return { ok: true, actionable: operation !== 'note', operation, targets, reason: '' }
}
