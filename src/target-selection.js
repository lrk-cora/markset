import { validateIntentPlan } from './intent-plan.js'

// Each stroke contributes evidence to an object already in the group. Keeping
// only its first hit loses later crossed words and the resulting scope.
export function mergeHitTargets(existing = [], hits = []) {
  const merged=new Map(existing.map(target=>[String(target.webId),target]))
  for (const hit of hits) {
    if (!hit?.webId) continue
    const key=String(hit.webId),previous=merged.get(key)
    if (!previous) {merged.set(key,hit);continue}
    const ranges=[...(previous.markedRanges || []),...(hit.markedRanges || [])]
      .filter(range=>Number.isInteger(range.start)&&Number.isInteger(range.end)&&range.end>range.start)
      .sort((a,b)=>a.start-b.start || a.end-b.end)
    const union=[]
    for(const range of ranges) {
      const last=union.at(-1)
      if (last && range.start<=last.end) last.end=Math.max(last.end,range.end)
      else union.push({...range})
    }
    const text=String(hit.text || previous.text || '')
    merged.set(key,{...previous,...hit,markedRanges:union.map(range=>({...range,text:!hit.textTruncated && range.end<=text.length ? text.slice(range.start,range.end) : range.text}))})
  }
  return [...merged.values()]
}

/** Excluding a child must also exclude selected ancestors that could edit it
 * indirectly. Use DOM containment, not overlapping screen rectangles. */
export function filterExcludedTargets(targets, excludedIds = [], resolveElement = () => null) {
  const excluded = new Set(excludedIds.map(String))
  if (!excluded.size) return targets || []
  const excludedElements = [...excluded].map(resolveElement).filter(Boolean)
  return (targets || []).filter((target) => {
    if (excluded.has(String(target.webId))) return false
    const element = resolveElement(String(target.webId))
    return !excludedElements.some((other) => element && (element.contains(other) || other.contains(element)))
  })
}

export function deselectTargetPatch(group, targetId, filterTargets = filterExcludedTargets) {
  if (!group?.targets?.some((target) => String(target.webId) === String(targetId))) return null
  const excludedTargetIds = [...new Set([...(group.excludedTargetIds || []), String(targetId)])]
  const targets = filterTargets(group.targets, excludedTargetIds)
  return {
    targets, excludedTargetIds, revision: (group.revision || 0) + 1,
    preview: null, status: 'suggested', model: null, modelPending: false, modelError: '',
    selectedAlternative: '', intentLocked: false, spatialRelations: [],
  }
}

/** Preserve a still-valid selected action, but never its old scope or preview. */
export function retargetSelectionPlan(group) {
  const intent = group.inferredIntent
  if (!intent || intent.type === 'note' || intent.needsClarification) return null
  const allowed = new Set((group.targets || []).map((target) => String(target.webId)))
  const targets = (intent.targets || []).filter((target) => allowed.has(String(target.webId)))
  const keepRanges = (ranges) => (ranges || []).filter((range) => allowed.has(String(range.targetId)))
  const candidate = {
    ...intent, targets, targetRanges: keepRanges(intent.targetRanges),
    parameters: { ...intent.parameters, targetRanges: keepRanges(intent.parameters?.targetRanges) },
    relations: (intent.relations || []).filter((relation) => allowed.has(String(relation.from)) && allowed.has(String(relation.to))),
  }
  const checked = validateIntentPlan(candidate, group.targets, group.customInstruction || group.userInstruction || '')
  return checked.ok && checked.actionable ? candidate : null
}
