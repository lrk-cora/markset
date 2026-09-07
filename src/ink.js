import { aabb, looksLikeXStroke, pathLength, segmentsIntersect } from './geometry.js'

const MAIN = ['改', '删', '色', '减', '添', '加']
const EXTRA = ['换', '短', '插', '叉', '润']
const GRID = 48
const SETTLE_MS = 1000

const HAND_TEMPLATES = {
  改: [
    [
      [[0.08, 0.2], [0.44, 0.2]],
      [[0.12, 0.2], [0.12, 0.74], [0.42, 0.74], [0.4, 0.5]],
      [[0.5, 0.1], [0.92, 0.28]],
      [[0.72, 0.14], [0.48, 0.9]],
      [[0.58, 0.44], [0.94, 0.86]],
    ],
    [
      [[0.12, 0.24], [0.4, 0.2], [0.14, 0.58], [0.4, 0.72]],
      [[0.52, 0.1], [0.88, 0.32], [0.7, 0.18], [0.46, 0.88]],
      [[0.6, 0.48], [0.92, 0.84]],
    ],
  ],
  删: [
    [
      [[0.08, 0.18], [0.4, 0.18], [0.4, 0.82], [0.08, 0.82], [0.08, 0.18]],
      [[0.16, 0.48], [0.34, 0.48]],
      [[0.58, 0.12], [0.58, 0.88]],
      [[0.78, 0.12], [0.78, 0.88], [0.9, 0.72]],
    ],
    [
      [[0.1, 0.2], [0.38, 0.2], [0.38, 0.78], [0.1, 0.78]],
      [[0.62, 0.12], [0.62, 0.88]],
      [[0.82, 0.14], [0.82, 0.86]],
    ],
  ],
  色: [
    [
      [[0.28, 0.08], [0.72, 0.08], [0.5, 0.08], [0.5, 0.28]],
      [[0.18, 0.3], [0.82, 0.3], [0.82, 0.9], [0.18, 0.9], [0.18, 0.3]],
      [[0.18, 0.58], [0.82, 0.58]],
    ],
    [
      [[0.45, 0.06], [0.7, 0.2], [0.42, 0.28]],
      [[0.2, 0.32], [0.8, 0.32]],
      [[0.2, 0.32], [0.2, 0.88]],
      [[0.8, 0.32], [0.8, 0.88]],
      [[0.2, 0.88], [0.8, 0.88]],
      [[0.22, 0.6], [0.78, 0.6]],
    ],
    [
      [[0.38, 0.08], [0.66, 0.22]],
      [[0.18, 0.34], [0.84, 0.34]],
      [[0.2, 0.34], [0.22, 0.86], [0.8, 0.86], [0.82, 0.34]],
      [[0.24, 0.6], [0.78, 0.6]],
    ],
  ],
  减: [
    [
      [[0.12, 0.18], [0.28, 0.3]],
      [[0.1, 0.42], [0.28, 0.58]],
      [[0.42, 0.14], [0.9, 0.14]],
      [[0.66, 0.14], [0.52, 0.88]],
      [[0.66, 0.42], [0.9, 0.8]],
      [[0.48, 0.5], [0.86, 0.5]],
    ],
    [
      [[0.08, 0.22], [0.24, 0.36]],
      [[0.1, 0.52], [0.26, 0.7]],
      [[0.4, 0.12], [0.88, 0.16], [0.62, 0.18], [0.48, 0.86]],
      [[0.56, 0.46], [0.9, 0.84]],
      [[0.5, 0.52], [0.84, 0.52]],
    ],
  ],
  添: [
    [
      [[0.08, 0.16], [0.22, 0.28]],
      [[0.06, 0.46], [0.24, 0.4]],
      [[0.08, 0.62], [0.24, 0.78]],
      [[0.38, 0.12], [0.9, 0.12]],
      [[0.64, 0.12], [0.64, 0.88]],
      [[0.42, 0.48], [0.88, 0.48]],
    ],
  ],
  加: [
    [
      [[0.12, 0.18], [0.12, 0.82], [0.4, 0.82]],
      [[0.58, 0.48], [0.92, 0.48]],
      [[0.75, 0.18], [0.75, 0.82]],
    ],
    [
      [[0.14, 0.16], [0.14, 0.84], [0.42, 0.76]],
      [[0.52, 0.28], [0.9, 0.28], [0.9, 0.82], [0.52, 0.82], [0.52, 0.28]],
    ],
    [
      [[0.16, 0.2], [0.16, 0.78]],
      [[0.16, 0.48], [0.4, 0.72]],
      [[0.56, 0.32], [0.9, 0.32], [0.9, 0.8], [0.56, 0.8], [0.56, 0.32]],
    ],
  ],
  叉: [
    [
      [[0.18, 0.18], [0.82, 0.82]],
      [[0.82, 0.18], [0.18, 0.82]],
    ],
  ],
}

let strokes = []
let timer = 0
let onWritten = null

export function onInkRecognized(fn) {
  onWritten = fn
}

export function getInkStrokes() {
  return strokes.map((s) => s.map((p) => ({ ...p })))
}

export function hasInk() {
  return strokes.length > 0
}

export function clearInk() {
  strokes = []
  window.clearTimeout(timer)
  timer = 0
  const svg = document.getElementById('ink-layer')
  if (svg) svg.replaceChildren()
}

export function undoLastInkStroke() {
  if (!strokes.length) return false
  strokes.pop()
  renderInk()
  window.clearTimeout(timer)
  timer = 0
  if (!strokes.length) {
    onWritten?.({ text: '', confident: false })
    return true
  }
  finishWriting()
  return true
}

function inkBox() {
  const pts = strokes.flat()
  if (!pts.length) return null
  return aabb(pts)
}

function nearBoxes(a, b, pad) {
  return a.x < b.x + b.w + pad && a.x + a.w > b.x - pad && a.y < b.y + b.h + pad && a.y + a.h > b.y - pad
}

function isWritingNow() {
  return strokes.length > 0 && timer !== 0
}

export function isLikelyInk(rawPoints, { hasSelection, hasNewContent }) {
  if (!rawPoints?.length) return false
  const box = aabb(rawPoints)
  if (!(box.w > 4 && box.h > 4)) return false
  const prev = inkBox()
  if (prev && nearBoxes(box, prev, 240)) return true
  if (isWritingNow() && box.w < 280 && box.h < 280) return true
  if (!hasSelection) return false
  if (box.w > 360 || box.h > 340) return false
  const longSwipe = box.w > box.h * 3.2 || box.h > box.w * 3.2
  if (longSwipe && hasNewContent) return false
  if (box.w < 280 && box.h < 280) return true
  const peri = 2 * (box.w + box.h)
  const len = pathLength(rawPoints)
  const scribbly = len > peri * 1.15 || looksLikeXStroke(rawPoints)
  if (hasNewContent && !scribbly) return false
  return scribbly || !hasNewContent
}

function renderInk() {
  const svg = document.getElementById('ink-layer')
  if (!svg) return
  svg.replaceChildren()
  for (const stroke of strokes) {
    if (stroke.length < 2) continue
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', '#1d1916')
    line.setAttribute('stroke-width', '3.2')
    line.setAttribute('stroke-linecap', 'round')
    line.setAttribute('stroke-linejoin', 'round')
    line.setAttribute('points', stroke.map((p) => `${p.x},${p.y}`).join(' '))
    svg.append(line)
  }
}

function centroid(pts) {
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p.x
    y += p.y
  }
  const n = Math.max(pts.length, 1)
  return { x: x / n, y: y / n }
}

function strokeKind(pts) {
  const box = aabb(pts)
  const a = pts[0]
  const b = pts[pts.length - 1]
  const span = Math.max(box.w, box.h, 0.2)
  const loop = Math.hypot(b.x - a.x, b.y - a.y) < 0.14 * span && box.w > 0.52 && box.h > 0.3
  if (loop) return 'box'
  if (box.w > box.h * 1.75) return 'h'
  if (box.h > box.w * 1.75) return 'v'
  const dx = Math.abs(b.x - a.x)
  const dy = Math.abs(b.y - a.y)
  if (dx > dy * 1.7) return 'h'
  if (dy > dx * 1.7) return 'v'
  return 'd'
}

function isMostlyDiagonal(pts) {
  if (!pts || pts.length < 2) return false
  const a = pts[0]
  const b = pts[pts.length - 1]
  const dx = Math.abs(b.x - a.x)
  const dy = Math.abs(b.y - a.y)
  const m = Math.max(dx, dy, 1)
  return dx / m > 0.38 && dy / m > 0.38
}

function isFairlyStraight(pts) {
  const box = aabb(pts)
  const diag = Math.hypot(box.w, box.h)
  return pathLength(pts) < diag * 1.45
}

function strokesCross(a, b) {
  for (let i = 0; i < a.length - 1; i += 1) {
    for (let j = 0; j < b.length - 1; j += 1) {
      if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true
    }
  }
  return false
}

function countCrossings(list) {
  let n = 0
  let right = 0
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (!strokesCross(list[i], list[j])) continue
      n += 1
      const c = centroid([...list[i], ...list[j]])
      if (c.x > 0.48) right += 1
    }
  }
  return { n, right }
}

function normalizeStrokes(list) {
  const box = aabb(list.flat())
  const w = Math.max(box.w, 1)
  const h = Math.max(box.h, 1)
  return list.map((st) =>
    st.map((p) => ({
      x: (p.x - box.x) / w,
      y: (p.y - box.y) / h,
    })),
  )
}

function featuresOf(list) {
  const norm = normalizeStrokes(list)
  const pts = norm.flat()
  const n = list.length
  const kinds = norm.map(strokeKind)
  const span = (st) => {
    const box = aabb(st)
    return { w: box.w, h: box.h, len: pathLength(st), c: centroid(st) }
  }
  const info = norm.map(span)
  const rightDiag = info.filter((s, i) => {
    if (s.c.x <= 0.48 || s.len <= 0.28) return false
    const bent = s.len > Math.hypot(s.w, s.h) * 1.12
    if (kinds[i] === 'd') return s.len < Math.hypot(s.w, s.h) * 1.7
    return kinds[i] === 'v' && s.h > 0.35 && (s.w > 0.16 || bent)
  }).length
  const rightVert = info.filter(
    (s, i) => kinds[i] === 'v' && s.c.x > 0.64 && s.h > 0.45 && s.w / Math.max(s.h, 0.01) < 0.32 && s.len < Math.hypot(s.w, s.h) * 1.2,
  ).length
  const leftVert = info.filter((s, i) => kinds[i] === 'v' && s.c.x < 0.38 && s.h > 0.35).length
  const leftShort = info.filter((s) => s.c.x < 0.3 && s.len < 0.5 && s.h < 0.55).length
  const midH = info.some((s, i) => kinds[i] === 'h' && s.c.y > 0.38 && s.c.y < 0.72 && s.w > 0.28)
  const topH = info.some((s, i) => kinds[i] === 'h' && s.c.y < 0.34 && s.w > 0.22)
  const hasBox = kinds.includes('box')
  const twoH = info.filter((s, i) => kinds[i] === 'h' && s.w > 0.4).length >= 2
  const sideV = info.filter((s, i) => kinds[i] === 'v' && s.h > 0.28).length >= 2
  let left = 0
  let right = 0
  let top = 0
  let bot = 0
  for (const p of pts) {
    if (p.x < 0.42) left += 1
    if (p.x > 0.55) right += 1
    if (p.y < 0.3) top += 1
    if (p.y > 0.55) bot += 1
  }
  const total = Math.max(pts.length, 1)
  const enclosed = (hasBox || (twoH && sideV)) && leftShort < 2
  const cross = countCrossings(norm)
  return {
    n,
    rightDiag,
    rightVert,
    leftVert,
    leftShort,
    midH,
    topH,
    enclosed,
    leftShare: left / total,
    rightShare: right / total,
    topShare: top / total,
    botShare: bot / total,
    rightCross: cross.right,
    crosses: cross.n,
  }
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n))
}

function structureScores(list) {
  const f = featuresOf(list)
  const scores = Object.fromEntries([...MAIN, ...EXTRA].map((ch) => [ch, 0]))

  scores.改 =
    (f.rightDiag >= 2 ? 0.42 : f.rightDiag === 1 ? 0.18 : 0) +
    (f.rightCross >= 1 ? 0.18 : 0) +
    (f.leftShare > 0.18 && f.rightShare > 0.22 ? 0.14 : 0) +
    (f.n >= 3 && f.n <= 7 ? 0.12 : 0) -
    (f.rightVert >= 2 ? 0.36 : 0) -
    (f.leftShort >= 2 ? 0.32 : 0) -
    (f.enclosed ? 0.22 : 0) -
    (f.n >= 9 ? 0.16 : 0)

  scores.删 =
    (f.rightVert >= 2 ? 0.48 : f.rightVert === 1 ? 0.16 : 0) +
    (f.leftShare > 0.18 ? 0.1 : 0) +
    (f.n >= 4 && f.n <= 9 ? 0.08 : 0) +
    (f.leftVert >= 1 ? 0.08 : 0) -
    (f.rightDiag >= 2 && f.rightVert < 2 ? 0.36 : 0) -
    (f.leftShort >= 3 ? 0.22 : 0) -
    (f.enclosed ? 0.16 : 0)

  scores.色 =
    (f.enclosed ? 0.28 : 0) +
    (f.midH ? 0.22 : 0) +
    (f.topH || f.topShare > 0.1 ? 0.14 : 0) +
    (f.botShare > 0.18 ? 0.12 : 0) +
    (f.n >= 3 && f.n <= 8 ? 0.1 : 0) -
    (f.rightDiag >= 2 ? 0.3 : 0) -
    (f.rightVert >= 2 ? 0.26 : 0) -
    (f.leftShort >= 2 ? 0.2 : 0) -
    (f.n <= 2 ? 0.14 : 0)

  scores.减 =
    (f.leftShort >= 1 && f.rightVert < 2 ? 0.28 : 0) +
    (f.leftShort === 2 && f.leftVert === 0 ? 0.14 : 0) +
    (f.n >= 5 ? 0.16 : 0) +
    (f.n >= 5 && f.rightShare > 0.28 ? 0.1 : 0) -
    (f.enclosed ? 0.24 : 0) -
    (f.rightVert >= 2 ? 0.34 : 0) -
    (f.rightDiag >= 2 && f.leftShort < 1 ? 0.24 : 0) -
    (f.leftShort >= 3 ? 0.16 : 0) -
    (f.n <= 4 ? 0.12 : 0) -
    (f.midH && f.enclosed ? 0.16 : 0)

  scores.加 =
    (f.n >= 2 && f.n <= 5 ? 0.2 : 0) +
    (f.leftVert >= 1 && f.n <= 5 ? 0.16 : 0) +
    (f.rightVert === 1 && f.n <= 5 ? 0.2 : 0) +
    (f.midH && f.n <= 5 && f.rightDiag < 2 ? 0.12 : 0) -
    (f.rightDiag >= 2 ? 0.24 : 0) -
    (f.rightVert >= 2 ? 0.22 : 0) -
    (f.enclosed ? 0.16 : 0) -
    (f.leftShort >= 2 ? 0.16 : 0) -
    (f.n >= 7 ? 0.22 : 0)

  scores.添 =
    (f.leftShort >= 3 ? 0.44 : f.leftShort >= 2 && f.leftVert >= 1 ? 0.22 : 0) +
    (f.topH ? 0.12 : 0) +
    (f.n >= 6 ? 0.1 : 0) -
    (f.rightVert >= 2 ? 0.34 : 0) -
    (f.rightDiag >= 2 && f.leftShort < 2 ? 0.26 : 0) -
    (f.enclosed ? 0.28 : 0) -
    (f.n <= 4 ? 0.14 : 0)

  scores.叉 = f.n <= 3 && f.rightDiag + (f.crosses >= 1 ? 1 : 0) >= 2 ? 0.28 : 0
  scores.换 = f.n >= 6 && f.leftVert >= 1 ? 0.12 : 0
  scores.短 = 0
  scores.插 = 0
  scores.润 = 0

  for (const ch of Object.keys(scores)) scores[ch] = clamp01(scores[ch])
  return scores
}

function stampLine(grid, x0, y0, x1, y1, radius = 1.4) {
  const steps = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0)))
  const r = Math.ceil(radius)
  const r2 = radius * radius
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const cx = x0 + (x1 - x0) * t
    const cy = y0 + (y1 - y0) * t
    const ix = Math.round(cx)
    const iy = Math.round(cy)
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r2) continue
        const x = ix + dx
        const y = iy + dy
        if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue
        grid[y * GRID + x] = 1
      }
    }
  }
}

function paintNorm(normList) {
  const grid = new Uint8Array(GRID * GRID)
  const pad = 4
  const inner = GRID - pad * 2
  for (const st of normList) {
    for (let i = 1; i < st.length; i += 1) {
      stampLine(
        grid,
        pad + st[i - 1].x * inner,
        pad + st[i - 1].y * inner,
        pad + st[i].x * inner,
        pad + st[i].y * inner,
      )
    }
  }
  return grid
}

function paintTemplate(sets) {
  return paintNorm(sets.map((st) => st.map(([x, y]) => ({ x, y }))))
}

function f1(a, b) {
  let hit = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]) {
      na += 1
      if (b[i]) hit += 1
    }
    if (b[i]) nb += 1
  }
  if (!na || !nb) return 0
  const p = hit / na
  const r = hit / nb
  return (2 * p * r) / (p + r + 1e-6)
}

function zone3(grid) {
  const z = new Array(9).fill(0)
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      if (!grid[y * GRID + x]) continue
      const gx = Math.min(2, Math.floor((x * 3) / GRID))
      const gy = Math.min(2, Math.floor((y * 3) / GRID))
      z[gy * 3 + gx] += 1
    }
  }
  const n = Math.hypot(...z) || 1
  return z.map((v) => v / n)
}

function zoneDot(a, b) {
  let d = 0
  for (let i = 0; i < 9; i += 1) d += a[i] * b[i]
  return d
}

function templateScores(list) {
  const ink = paintNorm(normalizeStrokes(list))
  const inkZ = zone3(ink)
  const scores = {}
  for (const ch of [...MAIN, ...EXTRA]) {
    const sets = HAND_TEMPLATES[ch]
    if (!sets?.length) {
      scores[ch] = 0
      continue
    }
    scores[ch] = Math.max(
      ...sets.map((tmpl) => {
        const g = paintTemplate(tmpl)
        return 0.58 * f1(ink, g) + 0.42 * zoneDot(inkZ, zone3(g))
      }),
    )
  }
  return scores
}

function isSimpleX(pts) {
  if (!looksLikeXStroke(pts) || !isMostlyDiagonal(pts)) return false
  const box = aabb(pts)
  const len = pathLength(pts)
  const diag = Math.hypot(box.w, box.h)
  if (len > diag * 2.6) return false
  const ar = box.w / Math.max(box.h, 1)
  return ar > 0.45 && ar < 2.2
}

function looksLikeDeleteMark(list) {
  if (list.length >= 3) return false
  if (list.length === 1) return isSimpleX(list[0])
  if (list.length !== 2) return false
  const [a, b] = list
  if (!isMostlyDiagonal(a) || !isMostlyDiagonal(b)) return false
  if (!isFairlyStraight(a) || !isFairlyStraight(b)) return false
  return strokesCross(a, b)
}

export function recognizeStrokes(list) {
  const pts = list.flat()
  if (!list.length || pts.length < 6) return { text: '', confident: false, scores: {}, debug: null }
  if (looksLikeDeleteMark(list)) return { text: '×', confident: true, scores: { '×': 1 }, debug: { x: true } }

  const feat = featuresOf(list)
  const struct = structureScores(list)
  const vis = templateScores(list)
  const combined = {}
  for (const ch of [...MAIN, ...EXTRA]) {
    combined[ch] = 0.55 * (struct[ch] || 0) + 0.45 * (vis[ch] || 0)
  }

  const ranked = Object.entries(combined).sort((a, b) => b[1] - a[1])
  const [bestCh, bestScore] = ranked[0]
  const second = ranked[1]?.[1] ?? 0
  const amongMain = MAIN.map((ch) => [ch, combined[ch]]).sort((a, b) => b[1] - a[1])
  const pick = EXTRA.includes(bestCh) && amongMain[0][1] > bestScore - 0.06 ? amongMain[0] : [bestCh, bestScore]
  const confident = pick[1] >= 0.36 && pick[1] - second >= 0.05
  const text = pick[1] >= 0.22 ? pick[0] : ''
  return { text, confident, scores: combined, debug: { feat, struct, vis } }
}

function recognizeInk() {
  return recognizeStrokes(strokes)
}

function finishWriting() {
  timer = 0
  if (!strokes.length) return
  onWritten?.(recognizeInk())
}

export function addInkStroke(points) {
  const box = aabb(points)
  const prev = inkBox()
  const settled = timer === 0
  if (prev && settled && !nearBoxes(box, prev, 220)) strokes = []
  strokes.push(points.map((p) => ({ x: p.x, y: p.y })))
  renderInk()
  window.clearTimeout(timer)
  timer = window.setTimeout(finishWriting, SETTLE_MS)
}
