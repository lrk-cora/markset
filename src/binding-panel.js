import { BINDING_ROLES, inspectBindings, rangeFromQuote, correctionDescriptions } from './binding-corrections.js'

const placements = { 'inside-start': '内部开头', 'inside-end': '内部末尾', before: '前面', after: '后面' }
const label = target => `${target.kind === 'container' ? '模块' : target.kind === 'image' ? '图片' : '文字'} · ${target.context?.tag || ''} · ${String(target.text || target.alt || target.webId).slice(0, 65)}`
function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (className) node.className = className
  return node
}
function select(options, value, ariaLabel) {
  const node = element('select'); node.setAttribute('aria-label', ariaLabel)
  for (const [key, text] of options) { const option = element('option', text); option.value = key; node.append(option) }
  node.value = value; return node
}
function field(text, control) { const node = element('label', '', 'binding-field'); node.append(element('span', text), control); return node }

export function initBindingPanel({ root, getEvidence, onCorrect, onHighlight = () => {}, onLayout = () => {}, canCorrect = () => true }) {
  let renderedKey = ''
  root.addEventListener('toggle', () => { if (root.open) render(true); else { onHighlight(null); onLayout() } })
  function render(force = false) {
    const { group, regions, targets } = getEvidence(Boolean(root.open))
    root.hidden = !group || !regions.length
    if (!group || !root.open) return
    // Resizes/progress ticks must not replace focused controls or draft edits.
    const enabled = canCorrect()
    const key = `${group.id}:${group.revision}:${group.modelPending}:${group.applying}:${enabled}:${group.inferredIntent?.suggestion?.text || ''}`
    if (!force && key === renderedKey) return
    renderedKey = key
    const body = document.getElementById('binding-inspector-body'); body.replaceChildren()
    body.append(element('p', group.bindingRevision ? '纠正已保存。旧方案失效；点击“开始分析”重新生成，再确认修改。' : '以下来自当前方案，不是模型内部思维。纠正只更新约束，不调用模型。', 'binding-help'))
    if (!enabled) body.append(element('p', '当前对照条件：可查看，但关闭直接纠正；仍可在普通输入框补充要求并主动重新分析。', 'binding-help'))
    if (group.bindingRevision) {
      const reset = element('button', '清除全部纠正（仍需重新分析）', 'text-button'); reset.type = 'button'; reset.disabled = Boolean(group.applying) || !enabled
      reset.addEventListener('click', () => onCorrect(null, null)); body.append(reset)
    }
    for (const binding of inspectBindings(group, regions, targets)) {
      const row = element('section', '', 'binding-row'); row.dataset.regionId = binding.id
      row.append(element('strong', `${binding.source === 'plan-inspection' ? '方案对象' : '区域'} ${binding.number} · ${binding.kind === 'blank' ? '空白位置' : binding.source === 'plan-inspection' ? '非用户选区' : '对象范围'}`), element('p', binding.explanation, 'binding-help'))
      if (binding.planRanges.length) row.append(element('p', `方案文字范围：${binding.planRanges.map(range=>`“${range.text}” [${range.start}, ${range.end})`).join('；')}`, 'binding-help'))
      const object = select([...(binding.kind === 'blank' ? [['', '保持空白区域']] : []), ...targets.map(target => [String(target.webId), label(target)])], binding.targetIds[0] || '', `区域 ${binding.number} 的对象`)
      const role = select(Object.entries(BINDING_ROLES), binding.role, `区域 ${binding.number} 的角色`)
      const quote = element('input'); quote.type = 'text'; quote.value = binding.range?.expectedText || ''; quote.placeholder = '可选：粘贴唯一原文片段'; quote.maxLength = 900
      quote.setAttribute('aria-label', `区域 ${binding.number} 的文字范围`)
      const anchor = select([['', '不指定放置关系'], ...targets.map(target => [String(target.webId), label(target)])], binding.relation?.anchorId || '', `区域 ${binding.number} 的放置锚点`)
      const placement = select(Object.entries(placements), binding.relation?.placement || 'inside-end', `区域 ${binding.number} 的放置关系`)
      const existing = (group.inferredIntent?.type === 'batch' ? group.inferredIntent.steps : [group.inferredIntent])?.filter(Boolean).filter(step => ['move', 'insert'].includes(step.type)) || []
      if (existing.length) row.append(element('p', `当前空间步骤：${existing.map(step => `${step.type === 'move' ? '移动' : '插入'} → ${label(targets.find(target => target.webId === step.insertion?.anchorId) || { webId: '框内坐标' })} · ${placements[step.insertion?.placement] || '框内定位'}`).join('；')}`, 'binding-help'))
      const save = element('button', '保存纠正', 'button button-secondary'); save.type = 'button'
      const message = element('p', '', 'binding-message'); message.setAttribute('role', 'status')
      for (const control of [object, role, quote, anchor, placement, save]) control.disabled = Boolean(group.applying) || !enabled
      row.append(field('绑定对象 / 所属模块', object), field('对象角色', role), field('替换 / 删除只涉及这段文字', quote), field('放置到哪个对象', anchor), field('相对位置（用于插入或移动）', placement), save, message)
      object.addEventListener('change', () => { quote.value = ''; onHighlight(targets.find(target => target.webId === object.value) || null) })
      object.addEventListener('focus', () => onHighlight(targets.find(target => target.webId === object.value) || null))
      anchor.addEventListener('focus', () => onHighlight(targets.find(target => target.webId === anchor.value) || null))
      row.addEventListener('mouseleave', () => onHighlight(null))
      save.addEventListener('click', () => {
        const target = targets.find(target => target.webId === object.value)
        const checked = rangeFromQuote(target, quote.value)
        if (!checked.ok) { message.textContent = correctionDescriptions[checked.reason]; return }
        // Preserve multi-object bindings when the object selector is unchanged.
        const ids = object.value === (binding.targetIds[0] || '') ? binding.targetIds : object.value ? [object.value] : []
        const result = onCorrect({ regionId: binding.id, targetIds: ids, role: role.value, ...(checked.range ? { range: checked.range } : {}) },
          anchor.value ? { regionId: binding.id, anchorId: anchor.value, placement: placement.value } : null)
        if (!result.ok) message.textContent = correctionDescriptions[result.reason] || '纠正未保存，请重新检查范围'
        onHighlight(null)
      })
      body.append(row)
    }
    onLayout()
  }
  return { render }
}
