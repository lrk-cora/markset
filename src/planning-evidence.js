// Bound request size without turning a long circle/arrow into its first half.
// The authoritative ink is untouched; only the model payload is sampled.
export function sampleStrokePoints(points,maxPoints=180) {
  if (!Array.isArray(points)) return []
  const valid=points.filter(point=>Number.isFinite(point?.x) && Number.isFinite(point?.y))
  if (valid.length<=maxPoints) return valid.map(({x,y})=>({x,y}))
  return Array.from({length:maxPoints},(_,index)=>{
    const {x,y}=valid[Math.round(index*(valid.length-1)/(maxPoints-1))]
    return {x,y}
  })
}

/** Prefetch existing, authorized evidence, not new write permissions. Keep
 * full module data in read tools; prioritize selected nodes and their layout
 * parents/children/siblings instead of sending every unrelated descendant. */
export function initialPlanningEvidence(observation, { maxNodes = 28 } = {}) {
  if (!observation?.nodes?.length) return { nodes: [], totalNodes: 0, complete: true }
  const nodes = observation.nodes, byId = new Map(nodes.map(node => [String(node.webId), node]))
  const chosen = new Set()
  const add = (id) => { if (byId.has(String(id)) && chosen.size < maxNodes) chosen.add(String(id)) }
  const selected = (observation.selectedIds || []).map(String)
  selected.forEach(add)
  for (const id of selected) {
    let node = byId.get(id)
    for (let depth = 0; node && depth < 4; depth++) { add(node.context?.parentId); node = byId.get(String(node.context?.parentId)) }
  }
  for (const module of observation.modules || []) {
    add(module.webId)
    for (const gap of module.nearbyBlank || []) { add(gap.beforeId); add(gap.afterId) }
  }
  for (const stroke of observation.strokeEndpoints || []) {
    for (const candidate of [...(stroke.startCandidates || []), ...(stroke.endCandidates || [])]) add(candidate.webId)
  }
  const parents = new Set(selected.map(id => byId.get(id)?.context?.parentId).filter(Boolean))
  for (const node of nodes) if (parents.has(node.context?.parentId) || selected.includes(String(node.context?.parentId))) add(node.webId)
  for (const module of observation.modules || []) for (const id of module.children || []) add(id)
  const records = [...chosen].map(id => byId.get(id))
  return { nodes: records, totalNodes: nodes.length, complete: records.length === nodes.length }
}

const rounded = number => Number.isFinite(number) ? Math.round(number * 100) / 100 : number
const geometry = value => {
  if (Array.isArray(value)) return value.map(geometry)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['x','y','w','h','width','height','distance'].includes(key) && typeof item === 'number' ? rounded(item) : geometry(item)]))
}
const emptyStyles = { padding: ['0px'], margin: ['0px'], 'border-radius': ['0px'], 'background-color': ['rgba(0, 0, 0, 0)', 'transparent'] }

/** Model-only serialization. Authoritative geometry, text indices, original
 * read tools and all validation inputs remain untouched. No evidence is
 * inferred from omissions; only exact duplicates/defaults are removed. */
export function compactPlanningContext(context) {
  const result = geometry(context)
  result.strokes = (result.strokes || []).map(({ viewportPoints, ...stroke }) => stroke)
  result.targets = (result.targets || []).map(({ viewportRect, documentRect, charRects, textFragments, ...target }) => ({
    ...target,
    charBoxes: (charRects || []).map(({ index, char, rect }) => [index, char, rect?.x, rect?.y, rect?.w, rect?.h]),
    // markedRanges carries these identical fragments and their precise indices.
    ...(textFragments?.length && JSON.stringify(textFragments) !== JSON.stringify((target.markedRanges || []).map(({ start, end, text }) => ({ start, end, text }))) ? { textFragments } : {}),
  }))
  const nodes = result.initialEvidence?.nodes || [], byId = new Map(nodes.map(node => [String(node.webId), node]))
  const targetById = new Map(result.targets.map(target => [String(target.webId), target]))
  result.initialEvidence = { ...result.initialEvidence, nodes: nodes.map(node => {
    const compact = { ...node, styles: Object.fromEntries(Object.entries(node.styles || {}).filter(([key, value]) => value && !emptyStyles[key]?.includes(value))) }
    if (node.text && node.text === targetById.get(String(node.webId))?.text) { delete compact.text; compact.textRef = `target:${node.webId}` }
    else if (node.text && !node.textTruncated && node.children?.length) {
      const children = node.children.map(id => byId.get(String(id)))
      if (children.every(child => child && !child.textTruncated) && children.map(child => child.text || '').join(' ').replace(/\s+/gu,' ').trim() === node.text) {
        delete compact.text; compact.textFromChildren = true
      }
    }
    return compact
  }) }
  result.moduleCatalog = (result.moduleCatalog || []).map(module => {
    const node = byId.get(String(module.webId))
    if (module.text && module.text === node?.text) { const { text, ...rest } = module; return { ...rest, textRef: `node:${module.webId}` } }
    return module
  })
  if (JSON.stringify(result.evidence) === JSON.stringify(result.localEvidence)) delete result.evidence
  return result
}
