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

function hullCornerCount(pts) {
  const hull = convexHull(pts)
  if (hull.length < 3) return hull.length
  let n = 0
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[(i + hull.length - 1) % hull.length]
    const b = hull[i]
    const c = hull[(i + 1) % hull.length]
    const ang = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x))
    const deg = (Math.min(ang, Math.PI * 2 - ang) * 180) / Math.PI
    if (deg > 28 && deg < 158) n += 1
  }
  return n || hull.length
}

function countCrossings(pts) {
  if (!pts || pts.length < 6) return 0
  let n = 0
  for (let i = 0; i < pts.length - 1; i += 1) {
    for (let j = i + 2; j < pts.length - 1; j += 1) {
      if (i === 0 && j === pts.length - 2) continue
      if (segmentsIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1])) n += 1
    }
  }
  return n
}

/** Count outward spikes around the centroid. Stars have ~5; triangles have ~3. */
function radialPeakCount(pts) {
  if (!pts || pts.length < 8) return 0
  const box = aabb(pts)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const bins = 36
  const rad = new Array(bins).fill(0)
  for (const p of pts) {
    const ang = Math.atan2(p.y - cy, p.x - cx)
    const i = Math.floor((((ang + Math.PI) / (Math.PI * 2)) * bins) % bins)
    const r = Math.hypot(p.x - cx, p.y - cy)
    if (r > rad[i]) rad[i] = r
  }
  const max = Math.max(...rad, 1)
  const peaks = []
  for (let i = 0; i < bins; i += 1) {
    const a = rad[(i + bins - 1) % bins]
    const b = rad[i]
    const c = rad[(i + 1) % bins]
    if (b >= a && b >= c && b > max * 0.42 && b > Math.max(a, c) * 0.92) peaks.push(i)
  }
  if (!peaks.length) return 0
  if (peaks.length === 1) return 1
  let merged = 1
  for (let i = 1; i < peaks.length; i += 1) {
    if (peaks[i] - peaks[i - 1] > 2) merged += 1
  }
  if (peaks[0] + bins - peaks[peaks.length - 1] <= 2) merged -= 1
  return Math.max(1, merged)
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

export function looksLikeTwoStrokeX(a, b) {
  if (!a?.length || !b?.length) return false
  const chordA = dist(a[0], a[a.length - 1])
  const chordB = dist(b[0], b[b.length - 1])
  if (chordA < 16 || chordB < 16) return false
  if (looksLikeStarStroke([...a, ...b])) return false
  if (!segmentsIntersect(a[0], a[a.length - 1], b[0], b[b.length - 1])) return false
  const ba = aabb(a)
  const bb = aabb(b)
  const aspect = (box) => Math.max(box.w, box.h) / Math.max(1, Math.min(box.w, box.h))
  return aspect(ba) > 1.15 && aspect(bb) > 1.15
}

/** One-stroke pentagram: five spikes and crossing strokes, not a triangle. */
export function looksLikeStarStroke(pts) {
  if (!pts || pts.length < 16) return false
  const box = aabb(pts)
  if (box.w < 18 || box.h < 18) return false
  const crosses = countCrossings(pts)
  const peaks = radialPeakCount(pts)
  const hullN = hullCornerCount(pts)
  const hull = convexHull(pts)
  const hullLoop = hull.length >= 3 ? [...hull, hull[0]] : hull
  const wiggly = pathLength(hullLoop) > 1 ? pathLength(pts) / pathLength(hullLoop) : 0
  if (peaks >= 5 && (crosses >= 2 || wiggly > 1.42)) return true
  if (crosses >= 4 && peaks >= 4) return true
  if (peaks >= 5 && hullN >= 5 && wiggly > 1.35) return true
  const corners = turningCorners(pts, 32)
  return corners >= 8 && crosses >= 2 && peaks >= 4
}

export function looksLikeTriangleStroke(pts) {
  if (!pts || pts.length < 8) return false
  if (looksLikeStarStroke(pts)) return false
  const box = aabb(pts)
  if (box.w < 18 || box.h < 18) return false
  const crosses = countCrossings(pts)
  if (crosses >= 3) return false
  const peaks = radialPeakCount(pts)
  const hullN = hullCornerCount(pts)
  if (peaks >= 5 && (crosses >= 2 || hullN >= 5)) return false
  if (peaks >= 3 && peaks <= 4 && hullN <= 4 && crosses <= 1) return true
  const corners = turningCorners(pts)
  const round = roundness(pts)
  return corners >= 3 && corners <= 4 && round < 0.7 && hullN <= 4 && crosses <= 1
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

function strokeQuadrantCount(pts) {
  const box = aabb(pts)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  let bits = 0
  for (const p of pts) {
    bits |= 1 << ((p.x >= cx ? 1 : 0) | (p.y >= cy ? 2 : 0))
  }
  let n = 0
  for (let i = 0; i < 4; i += 1) if (bits & (1 << i)) n += 1
  return n
}

function regionInflate(pts) {
  const box = aabb(pts)
  return Math.max(14, Math.min(40, Math.min(box.w, box.h) * 0.1))
}

/** Casual circle / C / incomplete box still counts as a filled region, not a neat rectangle. */
export function looksLikeEnclosingStroke(pts) {
  if (!pts || pts.length < 6) return false
  const box = aabb(pts)
  if (box.w < 22 || box.h < 16) return false
  if (looksLikeDrawnLine(pts) && Math.min(box.w, box.h) < 36) return false
  const peri = 2 * (box.w + box.h)
  const len = pathLength(pts)
  if (len < peri * 0.24) return false
  const gap = dist(pts[0], pts[pts.length - 1])
  const span = Math.max(box.w, box.h)
  const minSpan = Math.min(box.w, box.h)
  const closed = gap < span * 0.58 || (gap < Math.max(52, minSpan * 0.9) && gap < len * 0.5)
  if (closed) return true
  const quads = strokeQuadrantCount(pts)
  if (quads >= 3 && box.w > 26 && box.h > 18 && len > peri * 0.26) return true
  if (quads >= 2 && minSpan > 32 && len > peri * 0.36) return true
  return false
}

/** 2D lasso meant to surround content. Thin underlines stay line-like. */
export function isRegionStroke(pts) {
  if (looksLikeEnclosingStroke(pts)) return true
  if (!pts || pts.length < 6) return false
  if (looksLikeDrawnLine(pts)) return false
  const box = aabb(pts)
  const min = Math.min(box.w, box.h)
  const peri = 2 * (box.w + box.h)
  const len = pathLength(pts)
  if (min > 22 && box.w * box.h > 36 * 24 && len > peri * 0.22) return true
  return false
}

export function enclosingPolygon(pts) {
  const cleaned = simplify(pts, 3)
  if (cleaned.length < 3) return cleaned
  const pad = regionInflate(cleaned)
  const loop = dist(cleaned[0], cleaned[cleaned.length - 1]) > 2 ? [...cleaned, cleaned[0]] : cleaned
  if (isSelfIntersecting(loop) || loop.length > 90) {
    const hull = convexHull(cleaned)
    if (hull.length >= 3) return inflatePolygon(hull, pad)
  }
  return inflatePolygon(loop, pad)
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
  if (enclosing && round > 0.55 && corners <= 6) return 'circle'
  if (looksLikeStarStroke(pts)) return 'star'
  if (looksLikeTriangleStroke(pts)) return 'triangle'
  if (looksLikeXStroke(pts)) return 'x'
  if (!enclosing && looksLikeDrawnLine(pts)) {
    if (len > chord * 1.55 && box.w > box.h * 2.1) return 'wavy'
    return 'line'
  }
  if (!enclosing && box.w > 22 && box.h > 22 && chord < Math.max(box.w, box.h) * 0.45) {
    if (corners >= 2 && corners <= 3 && box.h > box.w * 0.65) return 'check'
  }
  if (enclosing) {
    if (round > 0.7 && corners <= 4) return 'circle'
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

export function strokeFingerprint(pts) {
  if (!pts || pts.length < 4) return ''
  const box = aabb(pts)
  const diag = Math.hypot(box.w, box.h) || 1
  const corners = turningCorners(pts)
  const round = roundness(pts)
  const aspect = Math.max(box.w, box.h) / Math.max(1, Math.min(box.w, box.h))
  const density = pathLength(pts) / diag
  const gap = dist(pts[0], pts[pts.length - 1]) / diag
  return [
    looksLikeEnclosingStroke(pts) ? 'E' : 'O',
    isSelfIntersecting(pts) ? 'X' : 'N',
    corners >= 8 ? 'C3' : corners >= 5 ? 'C2' : corners >= 3 ? 'C1' : 'C0',
    round > 0.62 ? 'R2' : round > 0.38 ? 'R1' : 'R0',
    aspect > 2.8 ? 'A2' : aspect > 1.7 ? 'A1' : 'A0',
    density > 3.2 ? 'D2' : density > 2 ? 'D1' : 'D0',
    gap < 0.35 ? 'G1' : 'G0',
  ].join('-')
}

export function fingerprintsMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const pa = String(a).split('-')
  const pb = String(b).split('-')
  if (pa.length !== pb.length) return false
  let soft = 0
  for (let i = 0; i < pa.length; i += 1) {
    if (pa[i] === pb[i]) continue
    if ((pa[i][0] === 'R' || pa[i][0] === 'D') && pa[i][0] === pb[i][0]) {
      soft += 1
      if (soft > 1) return false
      continue
    }
    return false
  }
  return true
}

export function markTargetPolygon(pts, shape = '') {
  const box = aabb(pts)
  const lineLike = shape === 'line' || shape === 'wavy'
  const padX = lineLike ? 8 : 14
  const padY = lineLike ? 8 : 14
  const lift = lineLike ? Math.max(26, Math.min(52, box.w * 0.14)) : 0
  return [
    { x: box.x - padX, y: box.y - padY - lift },
    { x: box.x + box.w + padX, y: box.y - padY - lift },
    { x: box.x + box.w + padX, y: box.y + box.h + padY },
    { x: box.x - padX, y: box.y + box.h + padY },
  ]
}

/** Compact / scribbly / named strokes are marks; large loops are region lassos even if messy. */
export function looksLikeMarkStroke(pts, { hasSelection = false, selBox = null, knownFingerprints = [] } = {}) {
  if (!pts || pts.length < 4) return false
  const box = aabb(pts)
  const long = Math.max(box.w, box.h)
  const short = Math.min(box.w, box.h)
  const enclosing = isRegionStroke(pts)
  const named = classifyStrokeShape(pts)
  const distinctive = named === 'star' || named === 'x' || named === 'check' || named === 'arrow'
  if (enclosing && long > 120 && short > 34 && !distinctive) return false
  if (enclosing && long > 160 && !distinctive) return false
  const fp = strokeFingerprint(pts)
  if (fp && knownFingerprints.some((k) => fingerprintsMatch(fp, k))) return true
  if (named && named !== 'circle' && named !== 'box') return true
  if (named === 'circle' && long <= 130) return true
  if (named === 'box' && long <= 110) return true
  if (looksLikeDrawnLine(pts)) return true
  const corners = turningCorners(pts)
  const diag = Math.hypot(box.w, box.h) || 1
  const density = pathLength(pts) / diag
  const scribbly = isSelfIntersecting(pts) || corners >= 5 || density > 3.6
  if (scribbly && long <= 280) {
    if (enclosing && long > 90 && short > 40) return false
    return true
  }
  if (hasSelection && selBox) {
    const area = Math.max(1, box.w * box.h)
    const selArea = Math.max(1, selBox.w * selBox.h)
    const hit = intersectBoxes(box, {
      x: selBox.x - 24,
      y: selBox.y - 24,
      w: selBox.w + 48,
      h: selBox.h + 48,
    })
    if (hit && area < selArea * 0.92 && long < Math.max(selBox.w, selBox.h) * 1.2) return true
  }
  if (long <= 100 && short <= 100 && (corners >= 3 || density > 2.4)) {
    if (enclosing && long > 72 && short > 44) return false
    return true
  }
  return false
}

/**
 * select = region lasso; symbol-target = mark that also picks the object under it;
 * symbol = mark on an existing selection (keep the lasso).
 */
export function classifyStrokeKind(
  pts,
  { hasSelection = false, refine = false, selBox = null, knownFingerprints = [] } = {},
) {
  if (!pts || pts.length < 4) return { kind: 'none', shape: '', label: '', fingerprint: '' }
  if (refine) return { kind: hasSelection ? 'refine' : 'select', shape: '', label: '', fingerprint: '' }
  const fp = strokeFingerprint(pts)
  const named = classifyStrokeShape(pts)
  const shape = named || (fp ? `mark:${fp}` : '')
  const label = SHAPE_LABELS[named] || (named ? named : '自定义标记')
  const asMark = looksLikeMarkStroke(pts, { hasSelection, selBox, knownFingerprints })
  if (asMark) {
    const far = Boolean(
      selBox &&
        !intersectBoxes(aabb(pts), {
          x: selBox.x - 80,
          y: selBox.y - 80,
          w: selBox.w + 160,
          h: selBox.h + 160,
        }),
    )
    return {
      kind: hasSelection && !far ? 'symbol' : 'symbol-target',
      shape,
      label,
      fingerprint: fp,
    }
  }
  if (looksLikeEnclosingStroke(pts)) return { kind: 'select', shape: '', label: '', fingerprint: fp }
  if (hasSelection) {
    const box = aabb(pts)
    const long = Math.max(box.w, box.h)
    if (long <= 240) return { kind: 'symbol', shape, label, fingerprint: fp }
    return { kind: 'ink', shape: '', label: '', fingerprint: fp }
  }
  return { kind: 'select', shape: '', label: '', fingerprint: fp }
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

/** Filled region for a 2D lasso; thick ribbon only for line-like strokes. */
export function paintHitPolygon(pts, radius = 8) {
  if (looksLikeDrawnLine(pts) && !isRegionStroke(pts)) return strokeToPolygon(pts, Math.max(radius, 12))
  if (isRegionStroke(pts)) return enclosingPolygon(pts)
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
