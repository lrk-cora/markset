// A shared, derived index for the UI and planner. Numbers reference regions;
// they are never DOM IDs or edit commands. Raw ink/selection stay untouched.
const validRect = (r) => r && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(r[key])) && r.w > 0 && r.h > 0
const area = (r) => r.w * r.h
const intersection = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
const containsCenter = (a, b) => b.x + b.w / 2 >= a.x && b.x + b.w / 2 <= a.x + a.w && b.y + b.h / 2 >= a.y && b.y + b.h / 2 <= a.y + a.h
const nearSameRegion = (a, b) => intersection(a, b) / Math.max(area(a), area(b)) >= 0.65

export function orderBrushRegions(regions) {
  const rows = []
  const positioned = regions.map(region => ({ region, cx: region.rect.x + region.rect.w / 2, cy: region.rect.y + region.rect.h / 2 }))
  // Use centers on both axes: a tall frame's high top edge does not put it
  // before a higher-centered title. Cluster rows first to keep "near y"
  // comparisons transitive and independent of selection/drawing order.
  for (const item of positioned.sort((a, b) => a.cy - b.cy || a.cx - b.cx || a.region.id.localeCompare(b.region.id))) {
    const row = rows.find(row => item.cy - row.centerY <= Math.min(40, Math.max(8, Math.min(row.height, item.region.rect.h) / 4)))
    if (row) row.items.push(item)
    else rows.push({ centerY: item.cy, height: item.region.rect.h, items: [item] })
  }
  return rows.flatMap(row => row.items.sort((a, b) => a.cx - b.cx || a.cy - b.cy || area(b.region.rect) - area(a.region.rect) || a.region.id.localeCompare(b.region.id)))
    .map(({ region }, index) => ({ ...region, number: index + 1 }))
}

export function buildBrushRegions(group, resolveTargetRect = target => target.documentRect || target.screenRect || target.imageRect) {
  if (!group) return []
  const regions = [], targets = [], seen = new Set()
  const excluded = new Set((group.excludedTargetIds || []).map(String))
  const coordinateSpace = group.coordinateSpace || 'web-document'
  if (group.inputModality === 'selection') {
    for (const selection of group.selections || []) {
      const points = selection.points || [], xs = points.map(p => p.x), ys = points.map(p => p.y)
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys) }
      const ids = (selection.targetIds || []).filter(id => (group.targets || []).some(t => String(t.webId) === id) && !excluded.has(id))
      if (validRect(rect)) regions.push({ id: `selection:${selection.id}`, kind: ids.length ? 'target' : 'blank', source: 'selection', selectionId: selection.id, coordinateSpace, rect, targetIds: ids, strokeIds: [] })
    }
    return orderBrushRegions(regions)
  }
  for (const target of group.targets || []) {
    const id = String(target.webId || ''), rect = resolveTargetRect(target)
    if (!id || seen.has(id) || excluded.has(id) || !validRect(rect)) continue
    seen.add(id); targets.push({ target, rect })
    regions.push({ id: `target:${id}`, kind: 'target', coordinateSpace, rect: { ...rect }, targetIds: [id], strokeIds: [] })
  }
  for (const stroke of group.strokes || []) {
    if (stroke.role === 'subtract' || !(stroke.closed || ['circle', 'box'].includes(stroke.shape))) continue
    if (stroke.hitTargetIds?.length && stroke.hitTargetIds.every(id => !seen.has(String(id)))) continue
    const points = (stroke.points || []).filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    if (points.length < 3) continue
    const xs = points.map(p => p.x), ys = points.map(p => p.y)
    const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    if (!validRect(rect) || rect.w < 24 || rect.h < 24) continue
    const hits = targets.filter(({ target, rect: targetRect }) => intersection(rect, targetRect) / area(targetRect) >= 0.45
      || target.kind !== 'container' && containsCenter(targetRect, rect))
    if (hits.length) {
      for (const hit of hits) regions.find(region => region.targetIds.includes(String(hit.target.webId))).strokeIds.push(String(stroke.id))
      continue
    }
    const existing = regions.find(region => region.kind === 'blank' && nearSameRegion(region.rect, rect))
    if (existing) { existing.strokeIds.push(String(stroke.id)); continue }
    regions.push({ id: `blank:${stroke.id}`, kind: 'blank', coordinateSpace, rect, targetIds: [], strokeIds: [String(stroke.id)] })
  }
  return orderBrushRegions(regions)
}

// Numbered references need the shared map, not a keyword shortcut that could
// accidentally recolor/delete every selected target.
export function hasBrushRegionReference(text) {
  return /(?:区域|选区)\s*[#＃第]?\s*[\d一二三四五六七八九十百]+|第\s*[\d一二三四五六七八九十百]+\s*(?:个)?\s*(?:区域|选区)|\d+\s*号\s*(?:区域|选区)|\bR\d+\b/iu.test(String(text || ''))
}

export function positionBrushRegionLabels(regions) {
  const labels = []
  for (const region of regions) {
    let x = region.rect.x + 6
    const y = region.rect.y - 12
    // Nested or tightly adjacent targets can share a corner. Keep both numbers
    // readable instead of letting the later label cover the earlier one.
    while (labels.some(label => x < label.x + 28 && x + 28 > label.x && y < label.y + 26 && y + 26 > label.y)) x += 28
    labels.push({ region, x, y })
  }
  return labels
}

/** Paint exactly the same reference badges into the model's image evidence. */
export function drawBrushRegionNumbers(ctx, regions, projectPoint, scale = 1) {
  if (regions.length < 2) return
  ctx.save()
  ctx.globalAlpha = 1
  ctx.font = `700 ${12 * scale}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const projected = regions.flatMap(region => {
    const point = projectPoint(region, { x: region.rect.x, y: region.rect.y })
    return point ? [{ ...region, rect: { ...region.rect, x: point.x / scale, y: point.y / scale } }] : []
  })
  for (const label of positionBrushRegionLabels(projected)) {
    const { region } = label
    const size = 24 * scale, x = label.x * scale, y = Math.max(0, label.y * scale)
    ctx.fillStyle = '#315cf6'
    ctx.fillRect(x, y, size, size)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2 * scale
    ctx.strokeRect(x, y, size, size)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(String(region.number), x + size / 2, y + size / 2)
  }
  ctx.restore()
}

export function planningRegionEvidence(regions = [], targets = [], strokes = [], selections = []) {
  const targetIds = new Set(targets.map(target => String(target.webId)))
  const strokeIds = new Set(strokes.map(stroke => String(stroke.id)))
  const numbers = new Set()
  return regions.slice(0, 48).flatMap(region => {
    if (!region || !Number.isInteger(region.number) || region.number < 1 || numbers.has(region.number) || !validRect(region.rect)) return []
    const ids = (Array.isArray(region.targetIds) ? region.targetIds : []).map(String).filter(id => targetIds.has(id))
    const ink = (Array.isArray(region.strokeIds) ? region.strokeIds : []).map(String).filter(id => strokeIds.has(id))
    const selection = region.source === 'selection' && selections.find(item => item.id === region.selectionId)
    if (region.source === 'selection') {
      const points = selection?.points || []
      if (points.length !== 4 || points.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) return []
      const xs=points.map(p=>p.x), ys=points.map(p=>p.y)
      const actual={x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)}
      if (Object.keys(actual).some(key => Math.abs(actual[key]-region.rect[key])>1) || ids.some(id => !selection.targetIds?.includes(id))) return []
    }
    if (region.kind === 'target' ? !ids.length : region.kind !== 'blank' || !ink.length && !selection) return []
    numbers.add(region.number)
    return [{ id: String(region.id).slice(0, 120), number: region.number, kind: region.kind,
      coordinateSpace: region.coordinateSpace === 'viewport' ? 'viewport' : 'web-document',
      rect: { x: region.rect.x, y: region.rect.y, w: region.rect.w, h: region.rect.h }, targetIds: ids, strokeIds: ink,
      ...(selection ? { source: 'selection', selectionId: selection.id } : {}) }]
  })
}
