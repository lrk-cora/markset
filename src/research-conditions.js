// Experimental switches are explicit session state, not user/model history.
export const STUDY_VERSION = 'markset-pilot-v2'
export const RESEARCH_CONDITIONS = Object.freeze({
  'ink-correction': { label: '笔迹＋直接纠正', input: 'ink', correction: true, relations: true, family: 'recovery' },
  'ink-no-correction': { label: '笔迹＋文字补充', input: 'ink', correction: false, relations: true, family: 'expression-or-recovery' },
  'text-only': { label: '纯文字', input: 'text', correction: false, relations: true, family: 'expression' },
  'selection-text': { label: '矩形多选＋文字', input: 'selection', correction: false, relations: true, family: 'expression' },
  'ink-flat-evidence': { label: '笔迹＋扁平结构证据', input: 'ink', correction: false, relations: false, family: 'evidence-ablation' },
})
export function researchPolicy(condition) { return RESEARCH_CONDITIONS[condition] || { input: 'ink', correction: true, relations: true } }

// Keep IDs/content/coordinates/styles and safety observation. Remove only the
// precomputed hierarchy/endpoint enrichment exposed to the planner. The model
// may infer relations from pixels/raw marks; this is NOT removal of all relations.
export function flatResearchObservation(observation) {
  return { ...observation, modules: [], strokeEndpoints: [], nodes: (observation?.nodes || []).map(node => ({
    ...node, moduleId: undefined, children: undefined,
    context: { tag: node.context?.tag, className: node.context?.className },
  })) }
}
export function researchPlanningPayload(payload, condition) {
  const policy = researchPolicy(condition)
  if (!condition) return payload
  const value = { ...payload, researchCondition: condition, preferences: [], behaviorMemory: null }
  if (policy.input !== 'ink') value.strokes = []
  if (policy.input === 'text') { value.regions = []; value.selections = []; value.targets = (value.targets || []).filter(t => t.selected === false) }
  return value
}

export function rectanglePoints(start, end) {
  const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y)
  const w = Math.max(8, Math.abs(end.x - start.x)), h = Math.max(8, Math.abs(end.y - start.y))
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
}
