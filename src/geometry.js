export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function pathLength(pts) {
  let n = 0
  for (let i = 1; i < pts.length; i += 1) n += dist(pts[i - 1], pts[i])
  return n
}

export function aabb(pts) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function pointInPolygon(x, y, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i].x
    const yi = pts[i].y
    const xj = pts[j].x
    const yj = pts[j].y
    const denom = yj - yi || 1e-12
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / denom + xi
    if (hit) inside = !inside
  }
  return inside
}

export function pointInAnyPolygon(x, y, polys) {
  return (polys || []).some((pts) => pts?.length >= 3 && pointInPolygon(x, y, pts))
}

/** True if the box center is inside a polygon, or the two overlap a lot. */
export function boxHitsPolygon(box, poly) {
  if (!box || !poly?.length) return false
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  if (pointInPolygon(cx, cy, poly)) return true
  const hit = intersectBoxes(box, aabb(poly))
  if (!hit) return false
  const area = Math.max(1, box.w * box.h)
  return (hit.w * hit.h) / area >= 0.45
}

export function segmentsIntersect(a, b, c, d) {
  const det = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  if (Math.abs(det) < 1e-9) return false
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / det
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / det
  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99
}

export function isSelfIntersecting(pts) {
  const n = pts.length
  if (n < 4) return false
  for (let i = 0; i < n; i += 1) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue
      const c = pts[j]
      const d = pts[(j + 1) % n]
      if (segmentsIntersect(a, b, c, d)) return true
    }
  }
  return false
}

export function looksLikeXStroke(pts) {
  if (!pts || pts.length < 8 || !isSelfIntersecting(pts)) return false
  if (looksLikeStarStroke(pts)) return false
  const box = aabb(pts)
  if (box.w < 16 || box.h < 16) return false
  const corners = turningCorners(pts)
  if (corners >= 5) return false
  const len = pathLength(pts)
  const diag = Math.hypot(box.w, box.h)
  if (len > diag * 2.85) return false
  return len > diag * 1.45 && corners <= 4
}

/** One-stroke pentagram: many turns and a long path, not a simple two-line X. */
export function looksLikeStarStroke(pts) {
  if (!pts || pts.length < 16) return false
  const box = aabb(pts)
  if (box.w < 18 || box.h < 18) return false
  const corners = turningCorners(pts, 32)
  const len = pathLength(pts)
  const diag = Math.hypot(box.w, box.h)
  if (corners >= 8) return true
  if (corners >= 5 && (isSelfIntersecting(pts) || len > diag * 2.5)) return true
  return corners >= 4 && isSelfIntersecting(pts) && len > diag * 3.1
}

/** Several straight strokes fanning out from a hub, e.g. sunburst around a logo. */
export function looksLikeRadialBurst(strokes) {
  const list = (strokes || []).filter((s) => s?.length >= 2)
  if (list.length < 5) return false
  const pts = list.flat()
  const box = aabb(pts)
  if (box.w < 60 || box.h < 60) return false
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const rays = []
  for (const s of list) {
    const a = s[0]
    const b = s[s.length - 1]
    const chord = dist(a, b)
    const len = pathLength(s)
    if (chord < 22 || len < 22) continue
    if (chord / len < 0.62) continue
    const da = Math.hypot(a.x - cx, a.y - cy)
    const db = Math.hypot(b.x - cx, b.y - cy)
    const inner = da < db ? a : b
    const outer = da < db ? b : a
    const dx = outer.x - inner.x
    const dy = outer.y - inner.y
    rays.push({ inner, angle: Math.atan2(dy, dx) })
  }
  if (rays.length < 5) return false
  const bins = new Set(rays.map((r) => Math.round((((r.angle + Math.PI) / (Math.PI * 2)) * 10) % 10)))
  if (bins.size < 4) return false
  const innerBox = aabb(rays.map((r) => r.inner))
  const innerSpan = Math.hypot(innerBox.w, innerBox.h)
  const outerSpan = Math.hypot(box.w, box.h)
  return innerSpan < outerSpan * 0.58
}

/** Shaft plus optional arrowhead, or a single long pointing stroke. */
export function looksLikeArrowGesture(strokes) {
  const list = (strokes || []).filter((s) => s?.length >= 2)
  if (!list.length || list.length > 6) return false
  if (looksLikeRadialBurst(list)) return false
  let best = null
  for (const s of list) {
    const len = pathLength(s)
    const box = aabb(s)
    const chord = dist(s[0], s[s.length - 1])
    if (len < 70 || chord < 56) continue
    if (len > chord * 2.4) continue
    const aspect = Math.max(box.w, box.h) / Math.max(1, Math.min(box.w, box.h))
    if (aspect < 1.8) continue
    if (!best || len > best.len) best = { s, len, chord }
  }
  if (!best) return false
  const end = best.s[best.s.length - 1]
  const heads = list.filter((s) => {
    if (s === best.s) return false
    const nearEnd = dist(s[0], end) < 42 || dist(s[s.length - 1], end) < 42
    return nearEnd && pathLength(s) < best.len * 0.55
  })
  return heads.length >= 1 || (list.length <= 2 && best.chord > 90)
}

export function looksLikeUnderlineGesture(strokes) {
  const list = (strokes || []).filter((s) => s?.length >= 2)
  if (!list.length || list.length > 3) return false
  if (looksLikeRadialBurst(list) || looksLikeArrowGesture(list)) return false
  return list.every((s) => {
    const box = aabb(s)
    const len = pathLength(s)
    return box.w > 36 && box.w > box.h * 3.2 && len < box.w * 2.2
  })
}

/** Long stroke that is a line (not a closed lasso, X, or small box). */
export function looksLikeDrawnLine(pts) {
  if (!pts || pts.length < 6) return false
  if (looksLikeBoxStroke(pts) || looksLikeXStroke(pts)) return false
  const box = aabb(pts)
  const len = pathLength(pts)
  const chord = dist(pts[0], pts[pts.length - 1])
  const long = Math.max(box.w, box.h)
  const short = Math.min(box.w, box.h)
  if (long < 48 || chord < 40) return false
  const aspect = long / Math.max(1, short)
  if (aspect < 2.2 && short > 28) return false
  if (len > chord * 2.6) return false
  if (chord < len * 0.32) return false
  return true
}

/** Small near-closed square/rectangle, e.g. two boxes drawn before a paragraph. */
export function looksLikeBoxStroke(pts) {
  if (!pts || pts.length < 5) return false
  const box = aabb(pts)
  if (box.w < 10 || box.h < 10 || box.w > 110 || box.h > 110) return false
  const aspect = box.w / Math.max(1, box.h)
  if (aspect < 0.4 || aspect > 2.4) return false
  const len = pathLength(pts)
  const peri = 2 * (box.w + box.h)
  if (len < peri * 0.38) return false
  const compact = box.w <= 78 && box.h <= 78
  if (len > peri * (compact ? 5.5 : 2.8)) return false
  const tolX = Math.max(4, box.w * 0.22)
  const tolY = Math.max(4, box.h * 0.22)
  const near = (v, t, tol) => Math.abs(v - t) <= tol
  const sides = [
    pts.some((p) => near(p.x, box.x, tolX)),
    pts.some((p) => near(p.x, box.x + box.w, tolX)),
    pts.some((p) => near(p.y, box.y, tolY)),
    pts.some((p) => near(p.y, box.y + box.h, tolY)),
  ].filter(Boolean).length
  return sides >= 3
}

function polygonArea(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i += 1) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(a) / 2
}

function turningCorners(pts, minDeg = 40) {
  const step = Math.max(5, pathLength(pts) / 36)
  const s = simplify(pts, step)
  if (s.length < 4) return 0
  let n = 0
  for (let i = 1; i < s.length - 1; i += 1) {
    const a = s[i - 1]
    const b = s[i]
    const c = s[i + 1]
    const ang = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x))
    const deg = (Math.min(ang, Math.PI * 2 - ang) * 180) / Math.PI
    if (deg > minDeg && deg < 155) n += 1
  }
  return n
}

function roundness(pts) {
  const box = aabb(pts)
  const aspect = Math.min(box.w, box.h) / Math.max(1, Math.max(box.w, box.h))
  const loop = dist(pts[0], pts[pts.length - 1]) > 3 ? [...pts, pts[0]] : pts
  const area = polygonArea(loop)
  const r = Math.max(box.w, box.h) / 2
  if (r < 4) return 0
  return Math.min(1, (area / Math.max(1, Math.PI * r * r)) * aspect)
}

/** Casual circle / C-shape / messy loop still counts as enclosing, not a neat rectangle. */
export function looksLikeEnclosingStroke(pts) {
  if (!pts || pts.length < 8) return false
  const box = aabb(pts)
  if (box.w < 28 || box.h < 18) return false
  const peri = 2 * (box.w + box.h)
  const len = pathLength(pts)
  if (len < peri * 0.32) return false
  if (looksLikeDrawnLine(pts) && Math.min(box.w, box.h) < 28) return false
  const gap = dist(pts[0], pts[pts.length - 1])
  const span = Math.max(box.w, box.h)
  const minSpan = Math.min(box.w, box.h)
  const closed = gap < span * 0.48 || (gap < Math.max(40, minSpan * 0.72) && gap < len * 0.38)
  if (closed) return true
  return gap < len * 0.48 && len > peri * 0.5 && box.w > 36 && box.h > 24
}

export function enclosingPolygon(pts) {
  const cleaned = simplify(pts, 3)
  if (cleaned.length < 3) return cleaned
  const loop = dist(cleaned[0], cleaned[cleaned.length - 1]) > 2 ? [...cleaned, cleaned[0]] : cleaned
  if (isSelfIntersecting(loop) || loop.length > 90) {
    const hull = convexHull(cleaned)
    if (hull.length >= 3) return inflatePolygon(hull, 10)
  }
  return inflatePolygon(loop, 10)
}

export function inflatePolygon(pts, pad) {
  if (!pts?.length || !(pad > 0)) return pts || []
  const box = aabb(pts)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  return pts.map((p) => {
    const dx = p.x - cx
    const dy = p.y - cy
    const len = Math.hypot(dx, dy) || 1
    return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad }
  })
}

export const SHAPE_LABELS = {
  line: '横线',
  wavy: '波浪线',
  circle: '圈',
  triangle: '三角形',
  star: '五角星',
  x: '叉',
  check: '勾',
  arrow: '箭头',
  box: '小方框',
}

export function classifyStrokeShape(pts) {
  if (!pts || pts.length < 4) return ''
  const box = aabb(pts)
  const len = pathLength(pts)
  const chord = dist(pts[0], pts[pts.length - 1])
  const enclosing = looksLikeEnclosingStroke(pts)
  const corners = turningCorners(pts)
  const round = roundness(pts)
  if (looksLikeStarStroke(pts)) return 'star'
  if (looksLikeXStroke(pts)) return 'x'
  if (!enclosing && looksLikeDrawnLine(pts)) {
    if (len > chord * 1.55 && box.w > box.h * 2.1) return 'wavy'
    return 'line'
  }
  if (!enclosing && box.w > 22 && box.h > 22 && chord < Math.max(box.w, box.h) * 0.45) {
    if (corners >= 2 && corners <= 3 && box.h > box.w * 0.65) return 'check'
    if (corners >= 3 && corners <= 4 && round < 0.66) return 'triangle'
  }
  if (enclosing) {
    if (corners >= 8 || (corners >= 5 && round < 0.62)) return 'star'
    if (round > 0.7 && corners <= 4) return 'circle'
    if (corners >= 3 && corners <= 4 && round < 0.66) return 'triangle'
    if (looksLikeBoxStroke(pts)) return 'box'
    if (round > 0.52) return 'circle'
  }
  return ''
}

export function classifyMarkShape(strokes) {
  const list = (strokes || []).filter((s) => s?.length >= 2)
  if (!list.length) return { shape: '', label: '' }
  const flat = list.length === 1 ? list[0] : list.flat()
  if (looksLikeStarStroke(flat) || classifyStrokeShape(flat) === 'star') {
    return { shape: 'star', label: SHAPE_LABELS.star }
  }
  if (looksLikeRadialBurst(list)) return { shape: '', label: '' }
  if (looksLikeArrowGesture(list)) return { shape: 'arrow', label: SHAPE_LABELS.arrow }
  if (list.length === 2) {
    const a = list[0]
    const b = list[1]
    const crosses =
      looksLikeXStroke([...a, ...b]) ||
      segmentsIntersect(a[0], a[a.length - 1], b[0], b[b.length - 1])
    if (crosses && !looksLikeStarStroke(flat)) return { shape: 'x', label: SHAPE_LABELS.x }
  }
  if (looksLikeUnderlineGesture(list)) return { shape: 'line', label: SHAPE_LABELS.line }
  const shape = classifyStrokeShape(flat)
  return { shape, label: SHAPE_LABELS[shape] || '' }
}

/** Distinctive mark drawn as the selection itself (not a generic oval/box). */
export function classifyLassoSymbol(pts) {
  const shape = classifyStrokeShape(pts)
  if (!shape || shape === 'box') return ''
  if (shape === 'circle') {
    const box = aabb(pts)
    if (box.w > 140 || box.h > 140) return ''
  }
  return shape
}

const SYMBOL_SHAPES = new Set(['star', 'triangle', 'x', 'check', 'arrow', 'line', 'wavy'])

/**
 * Decide whether a stroke is a selection region, a compact intent symbol, or handwriting.
 * Large irregular loops are always selection. Compact named shapes are symbols.
 * After a selection exists, symbols annotate; without a selection they also pick the object under the mark.
 */
export function classifyStrokeKind(pts, { hasSelection = false, refine = false } = {}) {
  if (!pts || pts.length < 4) return { kind: 'none', shape: '', label: '' }
  if (refine) return { kind: hasSelection ? 'refine' : 'select', shape: '', label: '' }
  const box = aabb(pts)
  const long = Math.max(box.w, box.h)
  const enclosing = looksLikeEnclosingStroke(pts)
  const shape = classifyStrokeShape(pts)
  const compact = long <= 220 && Math.min(box.w, box.h) <= 200
  const named = (SYMBOL_SHAPES.has(shape) || (shape === 'circle' && compact)) && shape
  const lineLike = shape === 'line' || shape === 'wavy'
  if (named && long > 280 && !lineLike && (shape === 'circle' || shape === 'triangle')) {
    return { kind: 'select', shape: '', label: '' }
  }
  if (named) {
    return {
      kind: 'symbol-target',
      shape: named,
      label: SHAPE_LABELS[named] || named,
    }
  }
  if (enclosing) return { kind: 'select', shape: '', label: '' }
  if (hasSelection) return { kind: 'ink', shape: '', label: '' }
  return { kind: 'select', shape: '', label: '' }
}

export function convexHull(pts) {
  const p = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  if (p.length <= 2) return p
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower = []
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) {
      lower.pop()
    }
    lower.push(pt)
  }
  const upper = []
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const pt = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) {
      upper.pop()
    }
    upper.push(pt)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

export function simplify(pts, minDist = 2) {
  if (pts.length < 2) return pts
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i += 1) {
    if (dist(out[out.length - 1], pts[i]) >= minDist) out.push(pts[i])
  }
  return out
}

/** Paint-stroke hit region: a thick ribbon around the polyline. */
export function strokeToPolygon(pts, radius = 18) {
  const cleaned = simplify(pts, 2)
  if (!cleaned.length) return []
  if (cleaned.length === 1) {
    const p = cleaned[0]
    const r = radius
    return [
      { x: p.x - r, y: p.y - r },
      { x: p.x + r, y: p.y - r },
      { x: p.x + r, y: p.y + r },
      { x: p.x - r, y: p.y + r },
    ]
  }
  const left = []
  const right = []
  for (let i = 0; i < cleaned.length; i += 1) {
    const prev = cleaned[Math.max(0, i - 1)]
    const next = cleaned[Math.min(cleaned.length - 1, i + 1)]
    let dx = next.x - prev.x
    let dy = next.y - prev.y
    const len = Math.hypot(dx, dy) || 1
    dx /= len
    dy /= len
    const nx = -dy * radius
    const ny = dx * radius
    left.push({ x: cleaned[i].x + nx, y: cleaned[i].y + ny })
    right.push({ x: cleaned[i].x - nx, y: cleaned[i].y - ny })
  }
  return left.concat(right.reverse())
}

/** Filled region for a casual loop; thick ribbon for a line-like stroke. */
export function paintHitPolygon(pts, radius = 8) {
  if (looksLikeEnclosingStroke(pts)) return enclosingPolygon(pts)
  return strokeToPolygon(pts, radius)
}

/** Self-intersecting lassos fall back to the convex hull as an outer contour. */
export function normalizeLasso(pts) {
  const cleaned = simplify(pts)
  if (cleaned.length < 3) return cleaned
  if (isSelfIntersecting(cleaned)) return convexHull(cleaned)
  return cleaned
}

export function rectIntersectsPolygon(rect, pts) {
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ]
  if (corners.some((c) => pointInPolygon(c.x, c.y, pts))) return true
  if (pts.some((p) => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom)) {
    return true
  }
  const edges = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ]
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    for (const [c, d] of edges) {
      if (segmentsIntersect(a, b, c, d)) return true
    }
  }
  return false
}

export function clientRectBox(rect) {
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

export function intersectBoxes(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const bot = Math.min(a.y + a.h, b.y + b.h)
  const w = r - x
  const h = bot - y
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/** Remaining rectangles after cutting `cut` out of `box`. */
export function subtractBox(box, cut) {
  const hit = intersectBoxes(box, cut)
  if (!hit) return [box]
  if (hit.w >= box.w - 0.5 && hit.h >= box.h - 0.5) return []
  const out = []
  if (hit.y > box.y + 0.5) {
    out.push({ x: box.x, y: box.y, w: box.w, h: hit.y - box.y })
  }
  const boxBot = box.y + box.h
  const hitBot = hit.y + hit.h
  if (hitBot < boxBot - 0.5) {
    out.push({ x: box.x, y: hitBot, w: box.w, h: boxBot - hitBot })
  }
  if (hit.x > box.x + 0.5) {
    out.push({ x: box.x, y: hit.y, w: hit.x - box.x, h: hit.h })
  }
  const boxRight = box.x + box.w
  const hitRight = hit.x + hit.w
  if (hitRight < boxRight - 0.5) {
    out.push({ x: hitRight, y: hit.y, w: boxRight - hitRight, h: hit.h })
  }
  return out.filter((r) => r.w >= 1 && r.h >= 1)
}

export function unionBoxes(a, b) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const r = Math.max(a.x + a.w, b.x + b.w)
  const bot = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: r - x, h: bot - y }
}

export function clampBox(box, bounds, min = 16) {
  let x = Math.max(bounds.x, box.x)
  let y = Math.max(bounds.y, box.y)
  let r = Math.min(bounds.x + bounds.w, box.x + box.w)
  let bot = Math.min(bounds.y + bounds.h, box.y + box.h)
  if (r - x < min) {
    if (x + min <= bounds.x + bounds.w) r = x + min
    else x = r - min
  }
  if (bot - y < min) {
    if (y + min <= bounds.y + bounds.h) bot = y + min
    else y = bot - min
  }
  x = Math.max(bounds.x, x)
  y = Math.max(bounds.y, y)
  r = Math.min(bounds.x + bounds.w, r)
  bot = Math.min(bounds.y + bounds.h, bot)
  return { x, y, w: Math.max(min, r - x), h: Math.max(min, bot - y) }
}
