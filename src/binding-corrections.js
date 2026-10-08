// Explicit user corrections are constraints, not model conversation history.
// Shared by client and server. Never retarget an already generated plan.
import { PLACEMENTS } from './edit-capabilities.js'

export const BINDING_ROLES = Object.freeze({ auto: '由本次要求决定', context: '仅作参考，不修改', change: '可修改对象', preserve: '保留现有内容', destination: '放置位置' })
export const planSteps = plan => plan?.type === 'batch' ? plan.steps || [] : plan ? [plan] : []
const id = value => String(value || '')
const targetIds = step => (step.targets || []).map(target => id(target.webId))
const parentId = node => id(node?.context?.parentId || node?.parentId)
const fail = reason => ({ ok: false, reason })

export function bindingTargetPool(selected = [], observation, corrections) {
  const pool = new Map(selected.map(target => [id(target.webId), { ...target, selected: true }]))
  for (const node of observation?.nodes || []) if (!pool.has(id(node.webId))) pool.set(id(node.webId), { ...node, selected: false, related: true })
  // Explicit rebinding authorizes considering the corrected object. It does
  // not authorize arbitrary objects elsewhere on the page.
  for (const binding of corrections?.bindings || []) for (const targetId of binding.targetIds) {
    const target = pool.get(targetId)
    if (target) pool.set(targetId, { ...target, selected: true, corrected: true })
  }
  return [...pool.values()]
}

export function normalizeBindingCorrections(raw, targets = [], regions = []) {
  if (raw == null) return { ok: true, value: { version: 1, revision: 0, bindings: [], relations: [] } }
  if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1
    || !Array.isArray(raw.bindings) || !Array.isArray(raw.relations) || raw.bindings.length > 48 || raw.relations.length > 48) return fail('invalid-binding-correction')
  const known = new Map(targets.map(target => [id(target.webId), target]))
  const regionMap = new Map(regions.map(region => [id(region.id), region]))
  const seenBindings = new Set(), seenRelations = new Set(), bindings = [], relations = []
  for (const binding of raw.bindings) {
    const region = regionMap.get(id(binding?.regionId))
    if (!region || seenBindings.has(region.id) || !Object.hasOwn(BINDING_ROLES, binding.role)
      || !Array.isArray(binding.targetIds) || binding.targetIds.length > 8
      || binding.targetIds.some(targetId => typeof targetId !== 'string' || !known.has(targetId))
      || new Set(binding.targetIds).size !== binding.targetIds.length
      || (region.kind !== 'blank' && !binding.targetIds.length)) return fail('invalid-binding-target')
    const value = { regionId: region.id, role: binding.role, targetIds: [...binding.targetIds], originalTargetIds: [...(region.targetIds || [])] }
    if (binding.range != null) {
      const range = binding.range, target = known.get(range.targetId)
      if (!target || target.kind !== 'text' || target.textTruncated || !binding.targetIds.includes(range.targetId)
        || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start
        || range.end > String(target.text || '').length || typeof range.expectedText !== 'string'
        || range.expectedText.length > 900 || String(target.text).slice(range.start, range.end) !== range.expectedText) return fail('invalid-binding-range')
      value.range = { targetId: range.targetId, start: range.start, end: range.end, expectedText: range.expectedText }
    }
    seenBindings.add(region.id); bindings.push(value)
  }
  for (const relation of raw.relations) {
    const region = regionMap.get(id(relation?.regionId))
    if (!region || seenRelations.has(region.id) || !known.has(relation.anchorId)
      || !PLACEMENTS.includes(relation.placement) || relation.placement === 'position') return fail('invalid-binding-relation')
    seenRelations.add(region.id)
    relations.push({ regionId: region.id, anchorId: relation.anchorId, placement: relation.placement })
  }
  return { ok: true, value: { version: 1, revision: raw.revision, bindings, relations } }
}

// UTF-16 offsets match the existing executor. Ambiguous repeated phrases are
// rejected locally instead of silently choosing the first occurrence.
export function rangeFromQuote(target, quote) {
  const text = String(target?.text || ''), expectedText = String(quote || '').trim()
  if (!expectedText) return { ok: true, range: null }
  const start = text.indexOf(expectedText)
  if (target?.kind !== 'text' || target.textTruncated || start < 0 || text.indexOf(expectedText, start + 1) !== -1) return fail('ambiguous-binding-range')
  return { ok: true, range: { targetId: id(target.webId), start, end: start + expectedText.length, expectedText } }
}

function descendant(childId, ancestorId, known) {
  let current = childId
  const visited = new Set()
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true
    visited.add(current); current = parentId(known.get(current))
  }
  return false
}

export function checkBindingConstraints(plan, corrections, targets = []) {
  if (!corrections?.revision) return { ok: true }
  const steps = planSteps(plan), known = new Map(targets.map(target => [id(target.webId), target]))
  const changed = (corrections.bindings || []).filter(binding => binding.role === 'change').flatMap(binding => binding.targetIds)
  for (const binding of corrections.bindings || []) {
    const rebound = binding.originalTargetIds.filter(old => !binding.targetIds.includes(old))
    for (const step of steps) {
      const writes = step.type === 'insert' || step.type === 'note' ? [] : targetIds(step)
      // A module cannot be replaced/deleted to bypass a protected child.
      const destructive = ['delete', 'replace', 'replace-image'].includes(step.type)
      for (const write of writes) {
        if (rebound.some(old => descendant(write, old, known) || descendant(old, write, known))
          && !binding.targetIds.some(correctedId => descendant(write, correctedId, known))) return fail('binding-old-target')
        const protectedHit = binding.targetIds.some(protectedId => descendant(write, protectedId, known) || descendant(protectedId, write, known))
        const explicitChildChange = changed.some(allowed => descendant(write, allowed, known)
          && binding.targetIds.some(protectedId => allowed !== protectedId && descendant(allowed, protectedId, known)))
        if (binding.role === 'context' && protectedHit && !explicitChildChange) return fail('binding-context-write')
        if (['preserve', 'destination'].includes(binding.role) && destructive && protectedHit) return fail('binding-preserved-content')
        if (binding.range && (descendant(binding.range.targetId, write, known) || descendant(write, binding.range.targetId, known))) {
          if (!['replace','delete'].includes(step.type)) return fail('binding-range-operation')
          const ranges = step.targetRanges || []
          if (!ranges.length || ranges.some(range => range.targetId !== binding.range.targetId || range.start < binding.range.start || range.end > binding.range.end)) return fail('binding-range-expanded')
        }
      }
    }
  }
  for (const relation of corrections.relations || []) {
    const binding = corrections.bindings.find(item => item.regionId === relation.regionId)
    const spatial = steps.filter(step => ['insert', 'move'].includes(step.type)
      && (corrections.relations.length > 1 || steps.some(item => item.regionId)
        ? step.regionId === relation.regionId
        : !binding?.targetIds.length || targetIds(step).some(targetId => binding.targetIds.includes(targetId))))
    if (plan.type !== 'note' && (!spatial.length || !spatial.some(step => step.insertion?.anchorId === relation.anchorId && step.insertion?.placement === relation.placement))) return fail('binding-placement-mismatch')
    if (spatial.some(step => step.insertion?.anchorId !== relation.anchorId || step.insertion?.placement !== relation.placement)) return fail('binding-placement-mismatch')
  }
  return { ok: true }
}

export function correctionPatch(group, corrections) {
  return { revision: (group.revision || 0) + 1, bindingRevision: corrections.revision, bindingCorrections: corrections,
    staleProposal: group.inferredIntent?.suggestion?.text || group.staleProposal || '', inferredIntent: null, localIntent: null, suggestion: null,
    preview: null, status: 'draft', analysisPaused: true, modelPending: false, model: null, modelError: '', analysisIssue: null,
    analysisProgress: null, intentLocked: false, selectedAlternative: '', validation: null, bindingSnapshot: null }
}

export function stampBindingPlan(plan, group) {
  return { ...plan, bindingStamp: { groupId: group.id, revision: group.revision, bindingRevision: group.bindingRevision || 0 } }
}

export function checkBindingStamp(plan, group) {
  const stamp = plan?.bindingStamp
  if (!stamp) return group.bindingRevision ? fail('binding-plan-stale') : { ok: true }
  return stamp.groupId === group.id && stamp.revision === group.revision && stamp.bindingRevision === (group.bindingRevision || 0)
    ? { ok: true } : fail('binding-plan-stale')
}

export function bindingReferenceIds(group, plan = group?.inferredIntent) {
  return [...new Set([...planSteps(plan).flatMap(step => [...targetIds(step), id(step.insertion?.anchorId)]),
    ...(group.bindingCorrections?.bindings || []).flatMap(binding => binding.targetIds),
    ...(group.bindingCorrections?.relations || []).map(relation => relation.anchorId)].filter(Boolean))]
}

export function checkBindingSnapshot(before, after) {
  if (!before) return { ok: true }
  if (!after || before.some(item => item.missing) || after.some(item => item.missing) || JSON.stringify(before) !== JSON.stringify(after)) return fail('binding-page-changed')
  return { ok: true }
}

// Read-only plan references for unmarked text requests. These are never
// submitted as user selections, drawn as ink, or granted correction authority.
export function inspectionRegions(group, regions) {
  if (group?.inputModality !== 'text' || regions.length) return regions
  const ids = [...new Set(planSteps(group.inferredIntent).flatMap(step => [...targetIds(step), id(step.insertion?.anchorId)]).filter(Boolean))]
  return ids.map((webId,index)=>({ id:`plan-ref:${webId}`,number:index+1,kind:'target',source:'plan-inspection',targetIds:[webId],strokeIds:[] }))
}

export function inspectBindings(group, regions, targets) {
  const plan = group.inferredIntent, steps = planSteps(plan), known = new Map(targets.map(target => [id(target.webId), target]))
  return regions.map(region => {
    const correction = group.bindingCorrections?.bindings?.find(binding => binding.regionId === region.id)
    const ids = correction?.targetIds || region.targetIds || []
    const writes = steps.filter(step => step.type !== 'insert' && step.type !== 'note' && targetIds(step).some(targetId => ids.includes(targetId)))
    const anchors = steps.filter(step => ids.includes(id(step.insertion?.anchorId)))
    const relation = group.bindingCorrections?.relations?.find(item => item.regionId === region.id)
    const planRanges = writes.flatMap(step => (step.targetRanges || []).filter(range => ids.includes(id(range.targetId))).map(range => ({ ...range, text:String(known.get(id(range.targetId))?.text || '').slice(range.start,range.end).slice(0,100) })))
    return { ...region, targetIds: ids, role: correction?.role || 'auto', range: correction?.range, planRanges,
      targets: ids.map(targetId => known.get(targetId)).filter(Boolean), relation,
      explanation: correction ? '用户已纠正' : writes.length ? `方案修改：${writes.map(step => step.type).join('、')}` : anchors.length ? '方案以此为放置锚点' : plan ? '仅作为标记证据；未发现直接写入' : '尚未形成方案，角色未确定' }
  })
}

export const correctionDescriptions = {
  'invalid-binding-correction': '纠正数据格式无效', 'invalid-binding-target': '纠正对象不在当前可检查范围内',
  'invalid-binding-range': '纠正的文字范围已失效', 'ambiguous-binding-range': '请填写原文中唯一出现的片段；截断或重复文字不能直接绑定',
  'invalid-binding-relation': '放置关系无效', 'binding-old-target': '方案仍修改了纠正前的对象',
  'binding-context-write': '方案改动了仅作参考的对象', 'binding-preserved-content': '方案删改了要求保留的内容',
  'binding-range-expanded': '方案超出了纠正的文字范围', 'binding-placement-mismatch': '方案未遵循纠正的放置关系',
  'binding-range-operation': '字符级范围暂仅支持文字替换或删除；整对象样式或移动需先清除文字范围',
  'binding-plan-stale': '旧方案已失效，请先重新分析', 'binding-page-changed': '目标内容或所属模块已变化，请重新分析',
}
