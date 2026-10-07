import { isRegionStroke, paintHitPolygon } from './geometry.js'
import { ping } from './store.js'
import { StrokeSession } from './stroke-session.js'
import { DEFAULT_BRUSH_SETTINGS, getBrushSettings, setBrushSettings, subscribeBrushSettings } from './brush-settings.js'
import { displayStrokePoints } from './stroke-render.js'

export const SELECT_COLOR = '#3c6fd4'

export const LAYOUT_PENS = [
  { id: 'select', hex: SELECT_COLOR, label: '圈选' },
  { id: 'red', hex: '#d94c3d', label: '红' },
  { id: 'green', hex: '#2f8f5b', label: '绿' },
  { id: 'orange', hex: '#e08b3c', label: '橙' },
  { id: 'teal', hex: '#2a9aa0', label: '青' },
]

let lassoMode = false
let subtractMode = false
let addMode = false
let colorMode = false
let strokeColor = getBrushSettings().color
let finishActiveStroke = null

export function isLassoMode() {
  return lassoMode
}

export function isSubtractMode() {
  return subtractMode
}

export function isAddMode() {
  return addMode
}

export function isColorMode() {
  return colorMode
}

export function getStrokeColor() {
  return strokeColor
}

export function isLayoutPen() {
  return strokeColor.toLowerCase() !== SELECT_COLOR.toLowerCase()
}

export function layoutPenOf(hex = strokeColor) {
  return LAYOUT_PENS.find((p) => p.hex.toLowerCase() === String(hex || '').toLowerCase()) || null
}

export function setStrokeColor(hex) {
  // Appearance never arms the brush or implies a webpage color operation.
  setBrushSettings({ color: hex || SELECT_COLOR })
  strokeColor = getBrushSettings().color
  syncButtons()
  ping()
}

function syncButtons() {
  document.body.classList.toggle('is-armed', lassoMode)
  document.body.classList.toggle('is-subtract', subtractMode)
  document.body.classList.toggle('is-add', addMode)
  document.body.classList.toggle('is-color', colorMode)
  const lasso = document.getElementById('btn-lasso')
  if (lasso) {
    lasso.setAttribute('aria-pressed', String(lassoMode && !subtractMode && !addMode && !colorMode))
    lasso.classList.toggle('is-on', lassoMode && !subtractMode && !addMode && !colorMode)
  }
  const add = document.getElementById('btn-add')
  if (add) {
    add.setAttribute('aria-pressed', String(addMode))
    add.classList.toggle('is-on', addMode)
  }
  const sub = document.getElementById('btn-subtract')
  if (sub) {
    sub.setAttribute('aria-pressed', String(subtractMode))
    sub.classList.toggle('is-on', subtractMode)
  }
  document.querySelectorAll('[data-pen]').forEach((el) => {
    const hex = el.getAttribute('data-pen') || ''
    el.classList.toggle('is-on', hex.toLowerCase() === strokeColor.toLowerCase())
  })
}

export function setLassoMode(on) {
  if (!on) finishActiveStroke?.()
  lassoMode = Boolean(on)
  if (lassoMode) {
    subtractMode = false
    addMode = false
    colorMode = false
  } else {
    subtractMode = false
    addMode = false
    colorMode = false
  }
  syncButtons()
  ping()
}

export function disarmDrawing() {
  finishActiveStroke?.()
  lassoMode = false
  subtractMode = false
  addMode = false
  colorMode = false
  syncButtons()
  ping()
}

export function setSubtractMode(on) {
  subtractMode = Boolean(on)
  if (subtractMode) {
    lassoMode = true
    addMode = false
    colorMode = false
  }
  syncButtons()
  ping()
}

export function setAddMode(on) {
  addMode = Boolean(on)
  if (addMode) {
    lassoMode = true
    subtractMode = false
    colorMode = false
  }
  syncButtons()
  ping()
}

export function setColorMode(on) {
  colorMode = Boolean(on)
  if (colorMode) {
    lassoMode = true
    subtractMode = false
    addMode = false
  }
  syncButtons()
  ping()
}

function uiTarget(e) {
  const el = e.target instanceof Element ? e.target : e.target?.parentElement
  return el?.closest?.(
    '.app-ui, .hl-handle, .img-handle, .badge, .scheme-tag, .toolbar, .novice-card, .card-guesses, .topbar, .inspector, .suggest, .confirm, .change-badge, .change-toggle, .coach, [data-guess-index], [data-typed-req], input, textarea',
  )
}

let paintMarks = []
let paintRenderFrame = 0
let paintFrameDoc = null
let paintSessionId = 0
let nextPaintMarkId = 0
let lastRenderedPaintKey = ''
let lastRenderedPaintViewportKey = ''

function frameSpace() {
  const iframe = document.getElementById('web-doc-frame')
  const doc = iframe?.contentDocument
  const frame = iframe?.getBoundingClientRect?.()
  if (!iframe || !doc || !frame) return null
  const root = doc.documentElement
  const win = doc.defaultView
  const zoomValue = Number.parseFloat(root?.style?.zoom || '')
  const zoom = Number.isFinite(zoomValue) && zoomValue > 0.05 ? zoomValue : 1
  return {
    iframe,
    doc,
    left: frame.left,
    top: frame.top,
    scrollX: win?.scrollX || root?.scrollLeft || 0,
    scrollY: win?.scrollY || root?.scrollTop || 0,
    zoom,
  }
}

function viewportToPage(point, space = frameSpace()) {
  if (!space) return { x: point.x, y: point.y }
  return {
    x: (point.x - space.left) / space.zoom + space.scrollX,
    y: (point.y - space.top) / space.zoom + space.scrollY,
  }
}

function pageToViewport(point, coordinateSpace = 'viewport', space = frameSpace()) {
  if (!space || coordinateSpace !== 'web-document') return { x: point.x, y: point.y }
  return {
    x: space.left + (point.x - space.scrollX) * space.zoom,
    y: space.top + (point.y - space.scrollY) * space.zoom,
  }
}

export function getPaintMarks() {
  const space = frameSpace()
  return paintMarks.map((m) => ({
    id: m.id,
    revision: m.revision || 0,
    color: m.color,
    width: m.width ?? DEFAULT_BRUSH_SETTINGS.width,
    opacity: m.opacity ?? DEFAULT_BRUSH_SETTINGS.opacity,
    smoothing: m.smoothing || DEFAULT_BRUSH_SETTINGS.smoothing,
    role: m.role || 'select',
    shape: m.shape || '',
    fingerprint: m.fingerprint || '',
    closed: Boolean(m.closed),
    points: m.points.map((point) => pageToViewport(point, m.coordinateSpace, space)),
  }))
}

export function hasPaintSelection() {
  return paintMarks.some((m) => m.role !== 'subtract' && m.role !== 'symbol' && m.points?.length >= 3)
}

export function keepPaintMark(points, { append = true, color = '#3c6fd4', role = 'select', shape = '', fingerprint = '', closed = false, id = '', revision = 0, width = DEFAULT_BRUSH_SETTINGS.width, opacity = DEFAULT_BRUSH_SETTINGS.opacity, smoothing = DEFAULT_BRUSH_SETTINGS.smoothing } = {}) {
  if (!points?.length) return
  if (!append) paintMarks = []
  const space = frameSpace()
  paintMarks.push({
    id: id || `paint-${++nextPaintMarkId}`,
    revision: Number(revision) || 0,
    points: points.map((point) => viewportToPage(point, space)),
    coordinateSpace: space ? 'web-document' : 'viewport',
    color,
    width, opacity, smoothing,
    role: role || 'select',
    shape: shape || '',
    fingerprint: fingerprint || '',
    closed: Boolean(closed),
  })
  renderPaintMarks()
}

export function setLastPaintRole(role) {
  if (!paintMarks.length) return
  paintMarks[paintMarks.length - 1] = {
    ...paintMarks[paintMarks.length - 1],
    role: role || paintMarks[paintMarks.length - 1].role,
  }
  renderPaintMarks()
}

export function lastPaintPoints() {
  const marks = getPaintMarks()
  const m = marks[marks.length - 1]
  return m?.points?.map((p) => ({ x: p.x, y: p.y })) || []
}

export function clearPaintMarks() {
  paintMarks = []
  paintSessionId += 1
  lastRenderedPaintKey = ''
  lastRenderedPaintViewportKey = ''
  renderPaintMarks()
}

// Keep the visual ink independent from the transient lasso SVG. The caller
// can restore this snapshot after any full application render without
// reinterpreting the gesture.
export function setPaintMarks(marks = []) {
  const nextMarks = (Array.isArray(marks) ? marks : []).map((mark) => ({
    ...mark,
    id: mark.id || `paint-${++nextPaintMarkId}`,
    revision: Number(mark.revision) || 0,
    points: (mark.points || []).map((point) => ({ x: point.x, y: point.y })),
  }))
  // This is a projection of the authoritative group, not a second history.
  // Stale analysis is rejected before it reaches the group store.
  paintMarks = nextMarks
  renderPaintMarks()
}

export function getPaintSessionId() {
  return paintSessionId
}

function polyToPath(pts) {
  if (!pts?.length) return ''
  return `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`
}

function renderPaintMarks() {
  const svg = document.getElementById('paint-layer')
  if (!svg) return
  const stage = document.querySelector('.stage')?.getBoundingClientRect?.()
  const frame = document.getElementById('web-doc-frame')?.getBoundingClientRect?.()
  // Fixed SVGs sit above the workspace. Paint belongs to the live canvas,
  // never to the sidebar, including during a layout transition.
  const rect = stage && frame ? {
    left: Math.max(stage.left, frame.left, 0), top: Math.max(stage.top, frame.top, 0),
    right: Math.min(stage.right, frame.right, window.innerWidth), bottom: Math.min(stage.bottom, frame.bottom, window.innerHeight),
  } : null
  const clip = rect ? `inset(${rect.top}px ${Math.max(0, window.innerWidth - rect.right)}px ${Math.max(0, window.innerHeight - rect.bottom)}px ${rect.left}px)` : ''
  svg.style.clipPath = clip
  const lasso = document.getElementById('lasso-layer')
  if (lasso) lasso.style.clipPath = clip
  const marks = getPaintMarks()
  const paintKey = marks.map((mark) => `${mark.id}:${mark.revision}:${mark.color}:${mark.width}:${mark.opacity}:${mark.smoothing}:${mark.role}:${mark.closed}:${mark.points.map((p) => `${p.x},${p.y}`).join(';')}`).join('|')
  const space = frameSpace()
  const viewportKey = space ? `${space.left}:${space.top}:${space.scrollX}:${space.scrollY}:${space.zoom}` : ''
  const fills = marks.map((mark) => mark.role !== 'symbol' && mark.closed && mark.points.length >= 3 ? paintHitPolygon(mark.points, 8) : [])
  const expectedNodes = marks.filter((mark) => mark.points.length >= 1).length + fills.filter((poly) => poly.length >= 3).length
  const actualNodes = svg.querySelectorAll('[data-stroke-id]').length
  if (paintKey === lastRenderedPaintKey && viewportKey === lastRenderedPaintViewportKey && actualNodes === expectedNodes) return
  svg.replaceChildren()
  lastRenderedPaintKey = paintKey
  lastRenderedPaintViewportKey = viewportKey
  for (const [index, mark] of marks.entries()) {
    const poly = fills[index]
    if (poly.length < 3) continue
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    fill.setAttribute('data-stroke-id', mark.id)
    fill.setAttribute('data-stroke-part', 'fill')
    fill.setAttribute('d', polyToPath(poly))
    fill.setAttribute('stroke', 'none')
    fill.setAttribute('pointer-events', 'none')
    fill.setAttribute('fill', mark.color)
    fill.setAttribute('fill-opacity', mark.opacity * 0.18)
    svg.append(fill)
  }
  for (const mark of marks) {
    if (!mark.points.length) continue
    if (mark.points.length === 1) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      dot.setAttribute('data-stroke-id', mark.id)
      dot.setAttribute('data-stroke-part', 'dot')
      dot.setAttribute('cx', mark.points[0].x)
      dot.setAttribute('cy', mark.points[0].y)
      dot.setAttribute('r', mark.width / 2)
      dot.setAttribute('fill', mark.color)
      dot.setAttribute('opacity', mark.opacity)
      svg.append(dot)
      continue
    }
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    line.setAttribute('data-stroke-id', mark.id)
    line.setAttribute('data-stroke-part', 'line')
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', mark.color)
    line.setAttribute('stroke-width', mark.width)
    line.setAttribute('stroke-linecap', 'round')
    line.setAttribute('stroke-linejoin', 'round')
    line.setAttribute('opacity', mark.opacity)
    line.setAttribute('vector-effect', 'non-scaling-stroke')
    if (mark.role === 'subtract') line.setAttribute('stroke-dasharray', '7 5')
    line.setAttribute('points', displayStrokePoints(mark.points, mark.smoothing).map((p) => `${p.x},${p.y}`).join(' '))
    svg.append(line)
  }
}

function drawColor({ erase, shiftHeld } = {}) {
  if (erase) return '#b44532'
  if (colorMode) return '#7b4cc4'
  if (isLayoutPen()) return strokeColor
  if (addMode || shiftHeld) return '#2f8f5b'
  return strokeColor
}

function schedulePaintRender() {
  if (paintRenderFrame) return
  paintRenderFrame = requestAnimationFrame(() => {
    paintRenderFrame = 0
    renderPaintMarks()
  })
}

function bindPaintPositionTracking() {
  window.addEventListener('scroll', schedulePaintRender, true)
  window.addEventListener('resize', schedulePaintRender)
  const iframe = document.getElementById('web-doc-frame')
  iframe?.addEventListener('load', () => {
    if (paintFrameDoc === iframe.contentDocument) return
    paintFrameDoc = iframe.contentDocument
    paintFrameDoc?.addEventListener('scroll', schedulePaintRender, { passive: true, capture: true })
    paintFrameDoc?.defaultView?.addEventListener('scroll', schedulePaintRender, { passive: true })
    schedulePaintRender()
  })
}

bindPaintPositionTracking()
subscribeBrushSettings(() => {
  strokeColor = getBrushSettings().color
  syncButtons()
})

export function bindLasso({ onStart, onBegin, onMove, onFinish, onCancel }) {
  const svg = document.getElementById('lasso-layer')
  const session = new StrokeSession()
  let line = null
  let shiftHeld = false
  let subtractHeld = false
  let pointerCaptureTarget = null
  let began = false
  let appearance = getBrushSettings()

  function clearSvg() { svg.replaceChildren(); line = null }
  function draw() {
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
      for (const [key, value] of Object.entries({ fill: 'none', 'stroke-width': appearance.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: appearance.opacity, 'vector-effect': 'non-scaling-stroke' })) line.setAttribute(key, value)
      svg.append(line)
    }
    line.setAttribute('stroke', appearance.color)
    line.setAttribute('points', displayStrokePoints(session.points, appearance.smoothing).map((p) => `${p.x},${p.y}`).join(' '))
  }
  function releaseCapture(id) {
    const target = pointerCaptureTarget
    pointerCaptureTarget = null
    try { target?.releasePointerCapture?.(id) } catch {}
  }
  function finish(e, { cancelled = false } = {}) {
    const id = session.pointerId
    const result = session.finish(e?.pointerId ?? id, e ? { x: e.clientX, y: e.clientY } : null, { cancelled })
    if (!result) return
    // Reset before callbacks: store emissions and lostpointercapture can be reentrant.
    releaseCapture(id)
    document.body.classList.remove('is-lassoing')
    try {
      if (result.kind === 'cancel') {
        onCancel?.({ drew: false, cancelled: true, tap: false })
        return
      }
      // A deliberate tap is ink too. Collapse sub-threshold mouse jitter to
      // one point; interrupted contact without a completed tap is not ink.
      const isDot = result.kind === 'tap'
      const points = isDot ? result.points.slice(0, 1) : result.points
      const wantsSubtract = Boolean(subtractHeld || subtractMode)
      const wantsAdd = Boolean((addMode || shiftHeld) && !wantsSubtract)
      const color = appearance.color
      const strokeId = `stroke-${++nextPaintMarkId}`
      // Recognition can fail, but it must never gate persistence of raw ink.
      let polygon = []
      let closed = false
      try { polygon = paintHitPolygon(points, 8); closed = !isDot && isRegionStroke(points) } catch (error) {
        console.debug('[markset brush] geometry skipped', error)
      }
      let persist
      try {
        persist = onFinish?.(polygon, {
          shift: shiftHeld && !wantsSubtract, subtract: wantsSubtract, add: wantsAdd,
          color: colorMode && !wantsSubtract, strokeColor: color, crossOut: false,
          rawPoints: points.map((p) => ({ ...p })), strokeId, closed, shape: isDot ? 'dot' : '',
          width: appearance.width, opacity: appearance.opacity, smoothing: appearance.smoothing,
        })
      } catch (error) {
        console.error('[markset brush] stroke commit failed', error)
      }
      if (persist !== false && !persist?.paintOwned) {
        // Legacy callers may still let the overlay own persistence. Never
        // duplicate a stroke already committed by an app callback that threw.
        if (!paintMarks.some((mark) => mark.id === strokeId)) keepPaintMark(points, {
          append: persist?.append !== false, id: persist?.strokeId || strokeId,
          color, role: persist?.role || (wantsSubtract ? 'subtract' : wantsAdd ? 'add' : 'select'),
          width: appearance.width, opacity: appearance.opacity, smoothing: appearance.smoothing,
          shape: persist?.shape || (isDot ? 'dot' : ''), fingerprint: persist?.fingerprint || '',
          closed: persist?.closed ?? closed,
        })
      }
    } finally { clearSvg() }
  }
  function interrupt() { if (session.active) finish(null, { cancelled: true }) }
  finishActiveStroke = interrupt

  function onPointerDown(e) {
    if (e.button !== 0 || uiTarget(e) || e.isPrimary === false) return
    // Do not turn toolbar, stage gutters or the scrollbar into a drawing surface.
    if (!e.target?.closest?.('.page') || document.querySelector('.page.is-guide')) return
    if (!lassoMode && !subtractMode && !addMode && !colorMode) return
    if (session.active) {
      if (session.pointerId !== e.pointerId) return
      // A fresh down for the same mouse/pen means its previous up was lost.
      // Finish the old samples instead of merging two independent strokes.
      interrupt()
    }
    e.preventDefault(); e.stopPropagation()
    session.begin(e.pointerId, { x: e.clientX, y: e.clientY })
    shiftHeld = Boolean(e.shiftKey)
    subtractHeld = Boolean(subtractMode || e.ctrlKey || e.metaKey || e.altKey)
    // Snapshot appearance once. A settings change cannot restyle half a stroke.
    appearance = { ...getBrushSettings(), color: drawColor({ erase: subtractHeld, shiftHeld }) }
    began = false
    // Window has no setPointerCapture. Capture on a stable parent-document
    // element so release is delivered even outside the page or over the UI.
    pointerCaptureTarget = document.getElementById('page-shell') || e.target
    try { pointerCaptureTarget.setPointerCapture(e.pointerId) } catch {}
    document.body.classList.add('is-lassoing')
    clearSvg()
    onStart?.()
  }
  function onPointerMove(e) {
    if (!session.active || e.pointerId !== session.pointerId) return
    // Recover a missed release rather than locking out every following stroke.
    if (e.pointerType === 'mouse' && e.buttons === 0) { interrupt(); return }
    e.preventDefault()
    const samples = e.getCoalescedEvents?.() || []
    for (const sample of [...samples, e]) session.add(e.pointerId, { x: sample.clientX, y: sample.clientY })
    if (session.length < 3) return
    if (!began) { began = true; onBegin?.() }
    draw(); onMove?.(session.points)
  }
  function onPointerUp(e) {
    if (!session.active || e.pointerId !== session.pointerId) return
    e.preventDefault(); finish(e)
  }
  function onPointerCancel(e) {
    if (!session.active || e.pointerId !== session.pointerId) return
    finish(e, { cancelled: true })
  }
  function onWheel(e) { if (session.active) e.preventDefault() }
  function onKey(e) {
    if (e.key === 'Escape' && session.active) {
      const id = session.pointerId
      session.reset(); releaseCapture(id); clearSvg()
      document.body.classList.remove('is-lassoing')
      onCancel?.({ drew: began, cancelled: true, tap: false })
    }
  }
  const events = [
    ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', onPointerUp],
    ['pointercancel', onPointerCancel], ['lostpointercapture', onPointerCancel],
    ['blur', interrupt], ['keydown', onKey],
  ]
  for (const [type, handler] of events) window.addEventListener(type, handler, true)
  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => {
    interrupt()
    if (finishActiveStroke === interrupt) finishActiveStroke = null
    for (const [type, handler] of events) window.removeEventListener(type, handler, true)
    window.removeEventListener('wheel', onWheel, true)
  }
}
