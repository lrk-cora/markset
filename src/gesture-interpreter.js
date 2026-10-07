import { aabb, looksLikeArrowGesture, looksLikeEnclosingStroke, looksLikeXStroke } from './geometry.js'

function uniqueTargets(hits) {
  const out = []
  const seen = new Set()
  for (const item of hits || []) {
    if (!item?.webId || seen.has(item.webId)) continue
    seen.add(item.webId)
    out.push(item)
  }
  return out
}

function contextOf(target) {
  return target?.context || {}
}

function targetLabel(targets) {
  const texts = targets.filter((t) => t.kind === 'text')
  const images = targets.filter((t) => t.kind === 'image')
  if (images.length && texts.length) return `${texts.length} 段文字和 ${images.length} 个图片`
  if (images.length) return `${images.length} 个图片`
  if (texts.length) return `${texts.length} 段文字`
  return '这块内容'
}

function arrowVector(strokes) {
  let best = null
  for (const stroke of strokes || []) {
    const points = stroke?.points || []
    if (points.length < 2) continue
    const first = points[0]
    const last = points[points.length - 1]
    const dx = last.x - first.x
    const dy = last.y - first.y
    const length = Math.hypot(dx, dy)
    if (!best || length > best.length) best = { dx, dy, length }
  }
  return best || { dx: 1, dy: 0, length: 0 }
}

function directionFor(strokes) {
  const vector = arrowVector(strokes)
  return Math.abs(vector.dx) >= Math.abs(vector.dy) ? 'horizontal' : 'vertical'
}

function orderFor(strokes) {
  const vector = arrowVector(strokes)
  return directionFor(strokes) === 'horizontal'
    ? (vector.dx >= 0 ? 'forward' : 'reverse')
    : (vector.dy >= 0 ? 'forward' : 'reverse')
}

function relationBetween(a, b) {
  const ar = a.screenRect || a.imageRect
  const br = b.screenRect || b.imageRect
  if (!ar || !br) return null
  const acx = ar.x + ar.w / 2
  const acy = ar.y + ar.h / 2
  const bcx = br.x + br.w / 2
  const bcy = br.y + br.h / 2
  const dx = bcx - acx
  const dy = bcy - acy
  const xGap = Math.max(0, Math.max(ar.x, br.x) - Math.min(ar.x + ar.w, br.x + br.w))
  const yGap = Math.max(0, Math.max(ar.y, br.y) - Math.min(ar.y + ar.h, br.y + br.h))
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  return {
    from: a.webId,
    to: b.webId,
    relation: horizontal ? (dx >= 0 ? 'right-of' : 'left-of') : (dy >= 0 ? 'below' : 'above'),
    distance: Math.round(Math.hypot(dx, dy)),
    gap: Math.round(horizontal ? xGap : yGap),
  }
}

function spatialRelations(targets) {
  const relations = []
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      const relation = relationBetween(targets[i], targets[j])
      if (relation) relations.push(relation)
      if (relations.length >= 12) return relations
    }
  }
  return relations
}

function peerEvidence(targets) {
  if (targets.length < 2) return { score: 0, commonParent: false, repeated: false, layout: '' }
  const contexts = targets.map(contextOf)
  const parentIds = contexts.map((ctx) => ctx.parentId).filter(Boolean)
  const commonParent = parentIds.length >= 2 && new Set(parentIds).size === 1
  const layouts = contexts.map((ctx) => ctx.layout).filter(Boolean)
  const layout = layouts.find((value) => value === 'grid' || value === 'flex') || ''
  const repeated = commonParent && new Set(targets.map((target) => `${target.kind}:${contextOf(target).tag || ''}`)).size <= 2
  let score = 0
  if (commonParent) score += 0.42
  if (layout) score += 0.28
  if (repeated) score += 0.2
  if (targets.every((target) => target.kind === targets[0].kind)) score += 0.1
  return { score: Math.min(1, score), commonParent, repeated, layout }
}

function confidenceFor(group, kind, targets, evidence) {
  const strokeCount = group.strokes?.length || 0
  if (kind === 'reorder') return Math.min(0.94, 0.68 + evidence.score * 0.25 + (strokeCount > 1 ? 0.04 : 0))
  if (kind === 'replace-image') return targets.some((target) => target.kind === 'image') ? 0.86 : 0.42
  if (kind === 'replace') return targets.some((target) => target.kind === 'text') ? Math.min(0.88, 0.7 + (strokeCount > 1 ? 0.06 : 0)) : 0.42
  if (kind === 'delete') return targets.length ? (evidence.markedTextRange ? 0.9 : 0.66) : 0.4
  if (kind === 'insert') return 0.62
  return targets.length ? 0.48 : 0.38
}

export function interpretGroup(group) {
  const strokes = group.strokes || []
  const targets = uniqueTargets(group.targets)
  const shapes = strokes.map((stroke) => stroke.shape || '').filter(Boolean)
  const vector = arrowVector(strokes)
  const hasArrow = strokes.some((s) => s.shape === 'arrow') || looksLikeArrowGesture(strokes.map((s) => s.points))
  const hasRegion = strokes.some((s) => ['circle', 'box'].includes(s.shape)) || strokes.some((s) => looksLikeEnclosingStroke(s.points))
  // A region mark has precedence over noisy X detection. A closed lasso is
  // an object selector; deletion requires a separate, explicit mark.
  const hasCross = !hasRegion && (strokes.some((s) => s.shape === 'x') || strokes.some((s) => looksLikeXStroke(s.points)))
  const hasImage = targets.some((t) => t.kind === 'image')
  const hasText = targets.some((t) => t.kind === 'text')
  const markedRanges = targets.flatMap((target) => (target.kind === 'text' ? (target.markedRanges || []) : [])
    .map((range) => ({ ...range, targetId: target.webId })))
  const markedTextRange = markedRanges.some((range) => String(range.text || '').trim().length > 0)
  // Do not infer deletion from aspect ratio alone. A large lasso, a box, or
  // a drag across a paragraph can all be wide. Deletion requires a named
  // strike/cross gesture or a concrete character range hit by the ink.
  const textStrike = strokes.some((stroke) => ['line', 'strike'].includes(stroke.shape || ''))
  const peer = peerEvidence(targets)
  let type = 'note'
  let text = '我还不能可靠判断这组笔迹要怎样修改。'
  let hint = '可以继续画一个更清晰的圈、箭头或叉，或补充你希望实现的效果。'
  let confidence = confidenceFor(group, type, targets, peer)
  let needsInput = false
  let alternatives = []

  if (hasArrow && !hasCross && targets.length > 1 && peer.score >= 0.34) {
    type = 'reorder'
    text = `将这 ${targets.length} 个对象整理为${directionFor(strokes) === 'horizontal' ? '横向' : '纵向'}排列`
    hint = peer.layout
      ? `已识别出它们属于同一${peer.layout === 'grid' ? '网格' : '弹性'}区域；确认前会先显示布局预览。`
      : '已识别出多个相邻对象；确认前会先显示布局预览。'
    confidence = confidenceFor(group, type, targets, peer)
  } else if (hasCross && hasText && !markedTextRange) {
    // A cross over a mixed card, or over a text block without a character
    // range, is usually an object-level removal mark. Only an image-only
    // cross asks for replacement input.
    type = 'delete'
    text = `移除${targetLabel(targets)}`
    hint = '叉标记覆盖了内容对象；将移除被标记的对象。'
    confidence = confidenceFor(group, type, targets, peer)
    alternatives = []
  } else if (hasCross && hasImage) {
    type = 'replace-image'
    text = `替换${targetLabel(targets)}`
    hint = '叉更像是在标记图片需要更换；输入图片 URL 后，我会先展示原位预览。'
    confidence = confidenceFor(group, type, targets, peer)
    needsInput = true
    alternatives = ['删除这个图片']
  } else if (hasText && markedTextRange && (hasCross || textStrike)) {
    type = 'delete'
    const markedText = markedRanges.map((range) => `「${String(range.text).trim()}」`).slice(0, 3).join('、')
    text = `删除${markedText || targetLabel(targets)}`
    hint = '笔迹直接划过了这些文字；只删除被标记的字词，保留其余内容。'
    confidence = markedTextRange ? 0.9 : confidenceFor(group, type, targets, peer)
    alternatives = []
  } else if (!targets.length && hasRegion) {
    type = 'insert'
    text = '在你框出的空白位置添加内容'
    hint = '这是一个插入位置；输入内容后再添加到页面。'
    confidence = confidenceFor(group, type, targets, peer)
    needsInput = true
  } else if (hasRegion) {
    // A circle/box is selection evidence, not an edit command. In particular,
    // never turn “I marked this text” into “replace this text” before the user
    // has explicitly chosen a text-edit action. This is the safety boundary
    // between understanding what was marked and deciding what to change.
    type = 'note'
    const excerpt = targets.find((t) => t.kind === 'text')?.text?.slice(0, 28) || ''
    text = `已标记${targetLabel(targets)}${excerpt ? `：「${excerpt}${excerpt.length >= 28 ? '…' : ''}」` : ''}`
    hint = '已识别标记对象。选择一项具体修改，或补充你希望实现的效果。'
    confidence = 0.64
    // A region mark identifies scope only. Removal is offered only when the
    // stroke itself supplies deletion evidence (cross/strike), never as a
    // default option for merely circling text.
    alternatives = ['调整颜色', '在标记对象旁添加内容', ...(peer.score >= 0.34 ? ['重新排列这些对象'] : [])]
    alternatives = [...new Set(alternatives)].slice(0, 3)
  } else if (targets.length) {
    type = 'note'
    text = `已识别${targetLabel(targets)}，但动作还不够明确`
    confidence = 0.62
    alternatives = ['修改这些内容', '将这些内容重新排列', ...(hasImage ? ['替换图片'] : [])]
    alternatives = [...new Set(alternatives)].slice(0, 3)
  }

  const relations = spatialRelations(targets)
  const bounds = strokes.length ? aabb(strokes.flatMap((s) => s.points || [])) : null
  return {
    type,
    operation: type === 'replace' ? 'replace_text' : type,
    confidence,
    goal: text,
    rationale: type === 'note' ? '现有笔迹能确定标记位置，但还需要确定具体的网页修改。' : `根据${hasArrow ? '箭头方向' : hasCross ? '叉除标记' : '页面对象关系'}和目标对象推断此方案。`,
    strategy: type === 'reorder' ? `保留对象本身，仅调整为${directionFor(strokes) === 'horizontal' ? '横向' : '纵向'}排列。` : type === 'delete' ? '仅移除被明确标记的目标对象。' : type === 'replace-image' ? '保留图片位置和尺寸，仅更换图片资源。' : type === 'insert' ? '在框选的空白位置插入一个与周边样式协调的内容块。' : '等待用户确定具体修改方式。',
    constraints: ['不修改未标记的页面内容', '应用前先预览并由用户确认'],
    impact: { scope: targetLabel(targets), riskLevel: type === 'delete' || type === 'reorder' ? 'medium' : 'low' },
    needsClarification: false,
    targets,
    relations,
    parameters: {
      shapes,
      hasArrow,
      hasCross,
      hasRegion,
      direction: directionFor(strokes),
      order: orderFor(strokes),
      arrowVector: { dx: Math.round(vector.dx), dy: Math.round(vector.dy) },
      bounds,
      coordinateSpace: group.coordinateSpace || 'viewport',
      peerEvidence: peer,
      markedTextRange,
      textStrike,
      targetRanges: markedRanges.map((range) => ({ ...range, expectedText: range.text })),
      explanation: { hasArrow, hasCross, hasRegion, hasImage, hasText },
    },
    evidence: {
      strokeCount: strokes.length,
      targetCount: targets.length,
      targetKinds: [...new Set(targets.map((target) => target.kind))],
      peer,
      markedTextRange,
      markedRanges,
    },
    suggestion: { text, alternatives },
    hint,
    needsInput,
    targetRanges: markedRanges.map((range) => ({ ...range, expectedText: range.text })),
  }
}
