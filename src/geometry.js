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
