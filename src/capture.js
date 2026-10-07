import { aabb, classifyLassoSymbol, classifyMarkShape, classifyStrokeKind, classifyStrokeShape, dist, looksLikeArrowGesture, looksLikeEnclosingStroke, looksLikeRadialBurst, looksLikeTwoStrokeX, looksLikeUnderlineGesture, pathLength, SHAPE_LABELS, unionBoxes } from './geometry.js'
import { loadImageEl } from './mask.js'
import { getSnapshot } from './store.js'
import { getInkStrokes, inkToDataUrl } from './ink.js'
import { getPaintMarks, lastPaintPoints } from './overlay.js'
import { displayStrokePoints, drawCanvasStroke } from './stroke-render.js'
import { drawBrushRegionNumbers } from './brush-regions.js'
import { describeCircledHits, insertHostScreenBox, isWebDocActive, screenToWebDocumentPoint } from './web-doc.js'
import { habitForShape, habitForStroke, habitGuess, listMarkFingerprints, shapeTitle } from './symbol-habits.js'
import { createRevisionCache } from './revision-cache.js'
import { pageEvidenceVersion, pageEvidenceCacheable } from './page-evidence-version.js'
import { runAnalysisTask } from './analysis-task.js'

let plannerBase = null
function plannerPage() {
  const iframe = document.getElementById('web-doc-frame')
  const host = document.getElementById('web-doc-host')
  const imported = Boolean(iframe?.contentDocument?.body && host && !host.hidden)
  const root = imported ? iframe.contentDocument.documentElement : document.querySelector('.page')
  return { root, doc: imported ? iframe.contentDocument : document, imported }
}

/** Local-only warmup: no ink snapshot, UI change, model call or edit. */
export async function warmAnnotationBase() {
  const page = plannerPage()
  if (!page.root) return { value: '', cacheHit: false, buildMs: 0 }
  if (plannerBase?.root !== page.root) {
    plannerBase = { root: page.root, cache: createRevisionCache({
      version: () => pageEvidenceVersion(page.doc, page.root),
      cacheable: () => pageEvidenceCacheable(page.doc),
      // Abandoned/hung captures cannot poison the shared in-flight entry.
      produce: () => runAnalysisTask(() => page.imported
        ? captureImportedPage({ quality: 0.86, pixelRatio: 1.1 }) : captureDemoPage(), { timeoutMs: 7_000 }),
    }) }
  }
  return plannerBase.cache.get()
}

export function clearAnnotationBaseCache() { plannerBase?.cache.clear(); plannerBase = null }

function markLine(span) {
  const id = span.markId ? `#${String(span.markId).replace(/^#/, '')}` : '(no-id)'
  if (span.kind === 'text') return `${id} text ${span.block_id || ''} ${span.text || ''}`.trim()
  if (span.kind === 'image') {
    const box = span.bbox ? `${span.bbox.x},${span.bbox.y},${span.bbox.w}x${span.bbox.h}` : ''
    const web = span.webId ? `web:${span.webId}` : ''
    return `${id} image ${span.block_id || ''} ${web} ${box}`.trim()
  }
  return `${id} ${span.kind}`
}

function pageFrame() {
  const iframe = document.getElementById('web-doc-frame')
  const host = document.getElementById('web-doc-host')
  if (iframe && host && !host.hidden) return iframe.getBoundingClientRect()
  const page = document.querySelector('.page')
  return page?.getBoundingClientRect() || null
}

async function captureImportedPage({ quality = 0.74, pixelRatio = 0.8 } = {}) {
  const iframe = document.getElementById('web-doc-frame')
  const host = document.getElementById('web-doc-host')
  const doc = iframe?.contentDocument
  if (!doc?.body || host?.hidden) return ''
  try {
    const { toJpeg } = await import('html-to-image')
    return await toJpeg(doc.body, {
      quality,
      pixelRatio,
      backgroundColor: '#ffffff',
      cacheBust: false,
      filter: (node) => node?.tagName !== 'SCRIPT' && node?.tagName !== 'LINK',
    })
  } catch {
    return ''
  }
}

async function captureDemoPage() {
  const page = document.querySelector('.page')
  if (!page) return ''
  try {
    const { toJpeg } = await import('html-to-image')
    return await toJpeg(page, {
      quality: 0.74,
      pixelRatio: 0.7,
      backgroundColor: '#fffaf2',
      cacheBust: false,
      filter: (node) => node?.tagName !== 'SCRIPT',
    })
  } catch {
    return ''
  }
}

function importedPageText() {
  const iframe = document.getElementById('web-doc-frame')
  const host = document.getElementById('web-doc-host')
  const doc = iframe?.contentDocument
  if (!doc?.body || host?.hidden) return ''
  return String(doc.body.innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
}

function importedImageSpace(image) {
  const iframe = document.getElementById('web-doc-frame')
  const doc = iframe?.contentDocument
  if (!doc?.body || !iframe || !image) return null
  const root = doc.documentElement
  const cssWidth = Math.max(root?.scrollWidth || 0, doc.body?.scrollWidth || 0, iframe.clientWidth || 1)
  const cssHeight = Math.max(root?.scrollHeight || 0, doc.body?.scrollHeight || 0, iframe.clientHeight || 1)
  return {
    cssWidth,
    cssHeight,
    scaleX: (image.naturalWidth || image.width) / cssWidth,
    scaleY: (image.naturalHeight || image.height) / cssHeight,
    toImagePoint(point) {
      const docPoint = screenToWebDocumentPoint(point)
      return { x: docPoint.x * this.scaleX, y: docPoint.y * this.scaleY }
    },
  }
}

function drawImageSpaceStrokes(ctx, points, color, width, space) {
  if (!space) return
  drawCanvasStroke(ctx, points, color, width, (point) => space.toImagePoint(point))
}

function drawViewportStrokes(ctx, points, color, width, frame, scaleX, scaleY) {
  if (!frame) return
  drawCanvasStroke(ctx, points, color, width, (point) => ({
    x: (point.x - frame.left) * scaleX, y: (point.y - frame.top) * scaleY,
  }))
}

async function compositePageAndStrokes(pageDataUrl, regions = []) {
  if (!pageDataUrl) return ''
  const frame = pageFrame()
  if (!frame || frame.width < 8 || frame.height < 8) return pageDataUrl
  try {
    const image = await loadImageEl(pageDataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || image.width
    canvas.height = image.naturalHeight || image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const space = importedImageSpace(image)
    const inkW = Math.max(5, canvas.width / 150)
    for (const mark of getPaintMarks()) {
      ctx.globalAlpha = mark.opacity
      const zoom = Number.parseFloat(document.getElementById('web-doc-frame')?.contentDocument?.documentElement?.style?.zoom) || 1
      const paintW = mark.width * (space ? space.scaleX / zoom : canvas.width / frame.width)
      const points = displayStrokePoints(mark.points, mark.smoothing)
      if (space) drawImageSpaceStrokes(ctx, points, mark.color || '#3c6fd4', paintW, space)
      else drawViewportStrokes(ctx, points, mark.color || '#3c6fd4', paintW, frame, canvas.width / frame.width, canvas.height / frame.height)
    }
    ctx.globalAlpha = 1
    for (const stroke of getInkStrokes()) {
      if (space) drawImageSpaceStrokes(ctx, stroke, '#111111', inkW, space)
      else drawViewportStrokes(ctx, stroke, '#111111', inkW, frame, canvas.width / frame.width, canvas.height / frame.height)
    }
    const zoom = Number.parseFloat(document.getElementById('web-doc-frame')?.contentDocument?.documentElement?.style?.zoom) || 1
    drawBrushRegionNumbers(ctx, regions, (region, point) => {
      if (space) return region.coordinateSpace === 'web-document' ? { x: point.x * space.scaleX, y: point.y * space.scaleY } : space.toImagePoint(point)
      return { x: (point.x - frame.left) * canvas.width / frame.width, y: (point.y - frame.top) * canvas.height / frame.height }
    }, space ? space.scaleX / zoom : canvas.width / frame.width)
    return canvas.toDataURL('image/jpeg', 0.86)
  } catch {
    return pageDataUrl
  }
}

function allStrokePoints() {
  const pts = []
  for (const mark of getPaintMarks()) {
    if (mark.points?.length) pts.push(...mark.points)
  }
  for (const stroke of getInkStrokes()) {
    if (stroke?.length) pts.push(...stroke)
  }
  return pts
}

function looksLikeLasso(pts) {
  return looksLikeEnclosingStroke(pts)
}

function handwritingStrokes() {
  const inks = getInkStrokes().filter((s) => s?.length >= 2)
  if (inks.length) return inks
  return getPaintMarks()
    .filter(
      (m) =>
        m.points?.length >= 2 &&
        m.role !== 'subtract' &&
        m.role !== 'add' &&
        (m.role === 'symbol' || !looksLikeLasso(m.points)),
    )
    .map((m) => m.points)
}

function strokesToBoard(strokes, { color = '#111111', maxSide = 720 } = {}) {
  const pts = (strokes || []).flat()
  if (pts.length < 2) return ''
  const box = aabb(pts)
  const pad = 36
  const rawW = Math.max(48, box.w + pad * 2)
  const rawH = Math.max(48, box.h + pad * 2)
  const scale = Math.min(6, maxSide / Math.max(rawW, rawH, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(280, Math.round(rawW * scale))
  canvas.height = Math.max(280, Math.round(rawH * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(8, canvas.width / 42)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    if (!stroke || stroke.length < 2) continue
    ctx.beginPath()
    ctx.moveTo((stroke[0].x - box.x + pad) * scale, (stroke[0].y - box.y + pad) * scale)
    for (let i = 1; i < stroke.length; i += 1) {
      ctx.lineTo((stroke[i].x - box.x + pad) * scale, (stroke[i].y - box.y + pad) * scale)
    }
    ctx.stroke()
  }
  return canvas.toDataURL('image/png')
}

export function hasDrawnStamp() {
  return handwritingStrokes().some((s) => s.length >= 4)
}

export function looksLikeDrawnPattern() {
  const strokes = handwritingStrokes().filter((s) => s?.length >= 4)
  if (!strokes.length) return false
  if (looksLikeRadialBurst(handwritingStrokes())) return true
  const pts = strokes.flat()
  const box = aabb(pts)
  if (box.w < 36 || box.h < 36) return false
  const len = strokes.reduce((n, s) => n + pathLength(s), 0)
  const peri = 2 * (box.w + box.h)
  const closedish = strokes.some((s) => {
    if (s.length < 8) return false
    return dist(s[0], s[s.length - 1]) < Math.min(box.w, box.h) * 0.28 && pathLength(s) > peri * 0.4
  })
  if (closedish && box.w > 48 && box.h > 48) return true
  if (strokes.length >= 4 && len > peri * 0.9) return true
  if (strokes.length >= 5 && len > peri * 0.45) return true
  if (len > Math.max(box.w, box.h) * 4 && Math.min(box.w, box.h) > 50) return true
  return false
}

export function strokeKindOptions() {
  const marks = getPaintMarks()
  const hasSelection =
    getSnapshot().spans.some((s) => s.layoutRole !== 'dest') ||
    marks.some((m) => (m.role === 'select' || m.role === 'add') && m.points?.length >= 3)
  const boxes = [
    ...marks.filter((m) => m.role === 'select' || m.role === 'add').map((m) => aabb(m.points)),
    ...getSnapshot()
      .spans.filter((s) => s.layoutRole !== 'dest' && s.screenRect)
      .map((s) => s.screenRect),
  ]
  const selBox = boxes.length ? boxes.reduce((a, b) => unionBoxes(a, b)) : null
  return { hasSelection, selBox, knownFingerprints: listMarkFingerprints() }
}

export function matchRecordedHabit() {
  const ctx = strokeKindOptions()
  const marks = getPaintMarks().filter((m) => m?.points?.length >= 3 && m.role !== 'subtract')
  const last = lastPaintPoints()
  const pool = [...marks]
  if (last?.length >= 3) pool.push({ points: last, role: 'symbol' })
  for (const stroke of handwritingStrokes()) {
    if (stroke?.length >= 3) pool.push({ points: stroke, role: 'symbol' })
  }
  const xHabit = habitForShape('x') || { shape: 'x', intent: 'delete', label: '删除', note: 'delete', scope: 'selection' }
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      if (!looksLikeTwoStrokeX(pool[i].points, pool[j].points)) continue
      return {
        shape: 'x',
        label: shapeTitle('x', xHabit.ask),
        fingerprint: xHabit.fingerprint || '',
        habit: xHabit,
      }
    }
  }
  let best = null
  let bestScore = -1
  for (const m of pool) {
    const kind = classifyStrokeKind(m.points, ctx)
    const named = (() => {
      const raw = kind.shape && !String(kind.shape).startsWith('mark:') ? kind.shape : classifyStrokeShape(m.points)
      const box = aabb(m.points)
      const big = Math.max(box.w, box.h) > 140
      if ((raw === 'circle' || raw === 'box') && big && m.role !== 'symbol' && kind.kind === 'select') return ''
      return raw || ''
    })()
    const habit =
      (named && habitForShape(named)) ||
      habitForStroke(m.points) ||
      (kind.shape ? habitForShape(kind.shape) : null)
    if (!habit) continue
    const distinctive =
      ['star', 'triangle', 'x', 'check', 'arrow', 'line', 'wavy'].includes(String(habit.shape)) ||
      String(habit.shape).startsWith('mark:')
    const symbolish = m.role === 'symbol' || kind.kind === 'symbol' || kind.kind === 'symbol-target'
    const score = (symbolish ? 8 : 0) + (distinctive ? 5 : 0) + (habit.fingerprint ? 1 : 0)
    if (score <= bestScore) continue
    bestScore = score
    best = {
      shape: habit.shape || named || kind.shape,
      label: shapeTitle(habit.shape, habit.ask),
      fingerprint: habit.fingerprint || kind.fingerprint,
      habit,
    }
  }
  return best
}

export function currentSymbolShape() {
  const recorded = matchRecordedHabit()
  if (recorded) return { shape: recorded.shape, label: recorded.label, fingerprint: recorded.fingerprint }
  const fromInk = classifyMarkShape(handwritingStrokes())
  if (fromInk.shape) return fromInk
  const marks = getPaintMarks().filter(
    (m) => m?.points?.length >= 4 && m.role !== 'subtract' && m.role !== 'add',
  )
  const ctx = strokeKindOptions()
  for (const mark of [...marks].reverse()) {
    const kind = classifyStrokeKind(mark.points, ctx)
    if (mark.role === 'symbol' || kind.kind === 'symbol' || kind.kind === 'symbol-target') {
      const shape = kind.shape || classifyLassoSymbol(mark.points)
      if (shape) return { shape, label: kind.label || SHAPE_LABELS[shape] || shapeTitle(shape), fingerprint: kind.fingerprint }
    }
    const shape = classifyLassoSymbol(mark.points)
    if (!shape) continue
    const box = aabb(mark.points)
    if (shape === 'circle' && (box.w > 140 || box.h > 140) && marks.length > 1) continue
    return { shape, label: SHAPE_LABELS[shape] || shape }
  }
  return { shape: '', label: '' }
}

export function classifyDrawnGesture() {
  const strokes = handwritingStrokes().filter((s) => s?.length >= 2)
  const mark = currentSymbolShape()
  if (mark.shape) {
    const habit = habitForShape(mark.shape) || habitForStroke(strokes[strokes.length - 1])
    if (habit) {
      const guess = habitGuess(habit, mark.shape)
      return {
        kind: habit.intent,
        shape: mark.shape,
        label: guess.label,
        hint: `用户习惯用${shapeTitle(mark.shape, mark.label)}表示「${habit.label}」。这是本地几何猜测，仅模型失败时采用。`,
        habit: true,
      }
    }
  }
  if (!strokes.length) return { kind: '', shape: mark.shape || '', label: '', hint: mark.shape ? `画出了${shapeTitle(mark.shape)}。还没有习惯，执行一次后会记住它代表什么。` : '', unknownHabit: Boolean(mark.shape) }
  if (looksLikeRadialBurst(strokes)) {
    return {
      kind: 'stamp',
      shape: 'radial',
      label: '把画出的光芒加到周围',
      hint: '多条线从中心散开，是给 Logo/物体加装饰或光芒。应把画出的图案贴到所画位置，不要当成空白插入文字，也不要当成删除涂鸦。',
    }
  }
  if (looksLikeArrowGesture(strokes)) {
    return {
      kind: 'move-layout',
      shape: 'arrow',
      label: '按箭头把模块挪到指出的位置',
      hint: '箭头表示布局：从模块指向要放到的位置，不是新选区，也不是插入文字。',
    }
  }
  if (looksLikeUnderlineGesture(strokes) && !habitForShape('line')) {
    return {
      kind: 'underline',
      shape: 'underline',
      label: '给圈中文字加下划线',
      hint: '横线画在文字下方，表示加下划线。',
    }
  }
  if (mark.shape && (['star', 'triangle', 'circle', 'check', 'x', 'line', 'wavy'].includes(mark.shape) || String(mark.shape).startsWith('mark:'))) {
    return {
      kind: '',
      shape: mark.shape,
      label: '',
      hint: `画出了${shapeTitle(mark.shape, mark.label)}。还没有习惯，先输入它代表什么并执行一次，下次就能一键调用。`,
      unknownHabit: true,
    }
  }
  if (looksLikeDrawnPattern()) {
    return {
      kind: 'stamp',
      shape: 'pattern',
      label: '加上画出的图案',
      hint: '用户直接画了要加上的图形，应把该图案贴到所画位置。',
    }
  }
  return { kind: '', shape: mark.shape || '', label: '', hint: '', unknownHabit: Boolean(mark.shape) }
}

export function drawnStampScreenBox() {
  const pts = handwritingStrokes().flat()
  if (pts.length < 2) return null
  const box = aabb(pts)
  return { x: box.x, y: box.y, w: Math.max(28, box.w), h: Math.max(28, box.h) }
}

export function drawnStampDataUrl() {
  const strokes = handwritingStrokes()
  const pts = strokes.flat()
  if (pts.length < 2) return ''
  const box = aabb(pts)
  const pad = 12
  const rawW = Math.max(28, box.w + pad * 2)
  const rawH = Math.max(28, box.h + pad * 2)
  const scale = Math.min(4, 480 / Math.max(rawW, rawH, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(48, Math.round(rawW * scale))
  canvas.height = Math.max(48, Math.round(rawH * scale))
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#1d1916'
  ctx.lineWidth = Math.max(3, canvas.width / 48)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    if (!stroke || stroke.length < 2) continue
    ctx.beginPath()
    ctx.moveTo((stroke[0].x - box.x + pad) * scale, (stroke[0].y - box.y + pad) * scale)
    for (let i = 1; i < stroke.length; i += 1) {
      ctx.lineTo((stroke[i].x - box.x + pad) * scale, (stroke[i].y - box.y + pad) * scale)
    }
    ctx.stroke()
  }
  return canvas.toDataURL('image/png')
}

function handwritingBoardDataUrl() {
  return strokesToBoard(handwritingStrokes())
}

function strokeBoardDataUrl() {
  const paints = getPaintMarks().map((m) => m.points).filter((s) => s?.length >= 2)
  const inks = getInkStrokes().filter((s) => s?.length >= 2)
  const pts = [...paints.flat(), ...inks.flat()]
  if (pts.length < 2) return ''
  const box = aabb(pts)
  const pad = 28
  const rawW = Math.max(48, box.w + pad * 2)
  const rawH = Math.max(48, box.h + pad * 2)
  const scale = Math.min(5, 720 / Math.max(rawW, rawH, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(240, Math.round(rawW * scale))
  canvas.height = Math.max(240, Math.round(rawH * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const draw = (strokes, color, width) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const stroke of strokes) {
      if (!stroke || stroke.length < 2) continue
      ctx.beginPath()
      ctx.moveTo((stroke[0].x - box.x + pad) * scale, (stroke[0].y - box.y + pad) * scale)
      for (let i = 1; i < stroke.length; i += 1) {
        ctx.lineTo((stroke[i].x - box.x + pad) * scale, (stroke[i].y - box.y + pad) * scale)
      }
      ctx.stroke()
    }
  }
  draw(paints, '#3c6fd4', Math.max(6, canvas.width / 70))
  draw(inks, '#111111', Math.max(7, canvas.width / 55))
  return canvas.toDataURL('image/png')
}

async function fitDataUrl(dataUrl, { maxSide = 720, quality = 0.84 } = {}) {
  if (!dataUrl) return ''
  try {
    const image = typeof dataUrl === 'string' ? await loadImageEl(dataUrl) : dataUrl
    const w = image.naturalWidth || image.width
    const h = image.naturalHeight || image.height
    if (w < 4 || h < 4) return typeof dataUrl === 'string' ? dataUrl : ''
    const scale = Math.min(1, maxSide / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return typeof dataUrl === 'string' ? dataUrl : ''
  }
}

async function cropFromPoints(pageDataUrl, pts, { pad = 36, maxSide = 880, quality = 0.92 } = {}) {
  const frame = pageFrame()
  if (!pageDataUrl || !frame || !pts || pts.length < 2) return ''
  try {
    const image = typeof pageDataUrl === 'string' ? await loadImageEl(pageDataUrl) : pageDataUrl
    const iw = image.naturalWidth || image.width
    const ih = image.naturalHeight || image.height
    const imported = importedImageSpace(image)
    let box
    let sx
    let sy
    let padX
    let padY
    if (imported) {
      const mapped = pts.map((point) => imported.toImagePoint(point))
      box = aabb(mapped)
      sx = 1
      sy = 1
      padX = pad * imported.scaleX
      padY = pad * imported.scaleY
    } else {
      box = aabb(pts)
      sx = iw / Math.max(1, frame.width)
      sy = ih / Math.max(1, frame.height)
      box = { x: (box.x - frame.left) * sx, y: (box.y - frame.top) * sy, w: box.w * sx, h: box.h * sy }
      padX = pad * sx
      padY = pad * sy
    }
    let x = Math.max(0, box.x - padX)
    let y = Math.max(0, box.y - padY)
    let w = Math.min(iw - x, Math.max(120 * sx, box.w + padX * 2))
    let h = Math.min(ih - y, Math.max(120 * sy, box.h + padY * 2))
    if (w < 16 || h < 16) return ''
    const canvas = document.createElement('canvas')
    const outScale = Math.min(3.2, maxSide / Math.max(w, h))
    canvas.width = Math.max(200, Math.round(w * outScale))
    canvas.height = Math.max(200, Math.round(h * outScale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return ''
  }
}

async function cropCloseup(pageDataUrl) {
  return cropFromPoints(pageDataUrl, allStrokePoints(), { pad: 36, maxSide: 860 })
}

async function cropInkCloseup(pageDataUrl) {
  const pts = handwritingStrokes().flat()
  if (pts.length < 2) return ''
  return cropFromPoints(pageDataUrl, pts, { pad: 48, maxSide: 900 })
}

function uniqueUrls(list) {
  const out = []
  const seen = new Set()
  for (const url of list || []) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

function insertCropPoints() {
  const pts = allStrokePoints()
  if (pts.length >= 2) return pts
  const box = insertHostScreenBox()
  if (!box) return []
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ]
}

/** Circled blank plus surrounding page, for insert-text / insert-image generation. */
export async function captureInsertScene() {
  const imported = await captureImportedPage({ quality: 0.84, pixelRatio: 1 })
  const demo = imported ? '' : await captureDemoPage()
  const pageShot = imported || demo
  const combined = await compositePageAndStrokes(pageShot)
  const source = combined || pageShot
  const pts = insertCropPoints()
  const around = await fitDataUrl(await cropFromPoints(source, pts, { pad: 240, maxSide: 960 }), {
    maxSide: 960,
    quality: 0.84,
  })
  const closeup = await fitDataUrl(await cropFromPoints(source, pts, { pad: 28, maxSide: 640 }), {
    maxSide: 640,
    quality: 0.86,
  })
  const page = await fitDataUrl(source, { maxSide: 720, quality: 0.74 })
  return {
    aroundImageDataUrl: around,
    circledImageDataUrl: closeup,
    pageImageDataUrl: page,
    pageText: importedPageText().slice(0, 1800),
  }
}

/** Page + ink + numbered marks for intent understanding. */
export async function captureAnnotationScene(editor, { regions = [], mode = 'legacy', signal } = {}) {
  if (mode === 'planner') return capturePlannerScene({ regions, signal })
  const marked = await captureMarkedPage(editor)
  const imported = await captureImportedPage({ quality: 0.86, pixelRatio: 1.1 })
  const demo = imported ? '' : await captureDemoPage()
  const pageShot = imported || demo || marked.imageDataUrl
  const combined = await compositePageAndStrokes(pageShot, regions)
  const source = combined || pageShot
  const writing = await fitDataUrl(handwritingBoardDataUrl() || inkToDataUrl(), { maxSide: 720, quality: 0.94 })
  const board = await fitDataUrl(strokeBoardDataUrl() || writing, { maxSide: 720, quality: 0.92 })
  const inkCloseup = await fitDataUrl(await cropInkCloseup(source), { maxSide: 900, quality: 0.92 })
  const closeup = await fitDataUrl(await cropCloseup(source), { maxSide: 860, quality: 0.88 })
  const page = await fitDataUrl(source, { maxSide: 720, quality: 0.78 })
  const ocrImages = uniqueUrls([writing])
  const images = uniqueUrls([writing, board, inkCloseup, closeup, page])
  return {
    ...marked,
    pageText: marked.pageText || importedPageText(),
    inkDataUrl: writing || board,
    inkCloseupDataUrl: inkCloseup,
    closeupDataUrl: closeup,
    combinedDataUrl: page,
    ocrImageDataUrls: ocrImages,
    imageDataUrls: images,
  }
}

// The active Agent needs just the marked overview and legible local close-up.
// Keep legacy OCR/ink-board captures available to their original callers.
async function capturePlannerScene({ regions, signal }) {
  const start = performance.now()
  const base = await warmAnnotationBase()
  signal?.throwIfAborted()
  const baseReady = performance.now()
  const page = plannerPage()
  const version = pageEvidenceVersion(page.doc, page.root)
  if (base.version && base.version !== version) throw Object.assign(new Error('页面已变化，请重新分析'), { code: 'capture_page_changed' })
  const points = allStrokePoints()
  const source = await compositePageAndStrokes(base.value, regions)
  signal?.throwIfAborted()
  // Decode once; derive both images from the same pixels/coordinate snapshot.
  const image = source ? await loadImageEl(source) : null
  const [overview, closeup] = image ? await Promise.all([
    fitDataUrl(image, { maxSide: 720, quality: 0.78 }),
    cropFromPoints(image, points, { pad: 36, maxSide: 860, quality: 0.88 }),
  ]) : ['', '']
  signal?.throwIfAborted()
  if (version !== pageEvidenceVersion(page.doc, page.root)) throw Object.assign(new Error('页面已变化，请重新分析'), { code: 'capture_page_changed' })
  return {
    pageText: importedPageText(), combinedDataUrl: overview, closeupDataUrl: closeup,
    imageDataUrls: uniqueUrls([overview, closeup]),
    captureMetrics: { captureMs: Math.round(performance.now() - start), baseWaitMs: Math.round(baseReady - start),
      baseBuildMs: Math.round(base.buildMs || 0), baseCacheHit: Boolean(base.cacheHit), baseShared: Boolean(base.shared),
      imageCount: uniqueUrls([overview, closeup]).length },
  }
}

/** Payload for planner A. Built locally; not sent unless the model gate is on. */
export async function captureMarkedPage(editor) {
  const snap = getSnapshot()
  const pageText = editor?.view?.state?.doc
    ? editor.view.state.doc.textBetween(0, editor.view.state.doc.content.size, '\n')
    : importedPageText()
  const marks = [
    isWebDocActive() ? describeCircledHits() : '',
    (snap.spans || []).map(markLine).join('\n'),
  ]
    .filter(Boolean)
    .join('\n')
  const img = editor?.view?.dom?.querySelector('img[data-block-id]')
  let imageDataUrl = ''
  if (img?.src) {
    try {
      const image = await loadImageEl(img.src.startsWith('data:') ? img.src : img.currentSrc || img.src)
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth || image.width
      canvas.height = image.naturalHeight || image.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      ctx.lineWidth = Math.max(3, Math.round(canvas.width / 220))
      ctx.font = `600 ${Math.max(18, Math.round(canvas.width / 28))}px sans-serif`
      for (const span of snap.spans || []) {
        if (span.kind !== 'image' || !span.bbox) continue
        ctx.strokeStyle = '#3c6fd4'
        ctx.fillStyle = '#3c6fd4'
        ctx.strokeRect(span.bbox.x, span.bbox.y, span.bbox.w, span.bbox.h)
        ctx.fillText(`#${span.markId || 'I'}`, span.bbox.x + 8, span.bbox.y + Math.max(22, canvas.width / 36))
      }
      imageDataUrl = canvas.toDataURL('image/jpeg', 0.85)
    } catch {
      imageDataUrl = ''
    }
  }
  return { imageDataUrl, marks, pageText }
}
